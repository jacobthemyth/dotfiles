#!/usr/bin/env python3
"""Tests for sessions.py (Claude Code / Codex session digests)."""

import importlib.util
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Pin local time so window and offset assertions are deterministic.
os.environ["TZ"] = "America/New_York"
time.tzset()

_spec = importlib.util.spec_from_file_location(
    "sessions_collector", Path(__file__).with_name("sessions.py")
)
sessions = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sessions)

HOME = "/home/dev"
REPOS = "/home/dev/Code"
CWD = "/home/dev/Code/acme/api-service"


def write_jsonl(path: Path, records) -> Path:
    """Write records (dicts, or raw strings for malformed lines) as JSONL."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(record if isinstance(record, str) else json.dumps(record))
            handle.write("\n")
    return path


class TempDirTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


def claude_user(content, ts, entrypoint="cli", cwd=CWD, branch="main", **extra):
    record = {
        "type": "user", "timestamp": ts, "cwd": cwd, "gitBranch": branch,
        "entrypoint": entrypoint, "isSidechain": False, "sessionId": "s",
        "message": {"role": "user", "content": content},
    }
    record.update(extra)
    return record


def claude_assistant(ts, text=None, edits=(), entrypoint="cli", cwd=CWD, branch="main"):
    content = []
    if text:
        content.append({"type": "text", "text": text})
    for file_path in edits:
        content.append({"type": "tool_use", "name": "Edit",
                        "input": {"file_path": file_path, "old_string": "a", "new_string": "b"}})
    return {
        "type": "assistant", "timestamp": ts, "cwd": cwd, "gitBranch": branch,
        "entrypoint": entrypoint, "isSidechain": False,
        "message": {"role": "assistant", "content": content},
    }


def codex_meta(sid, source="cli", originator="codex-tui", cwd=CWD, branch="main"):
    return {"timestamp": "2026-09-15T13:59:00Z", "type": "session_meta",
            "payload": {"id": sid, "session_id": sid, "cwd": cwd, "originator": originator,
                        "source": source, "thread_source": "user", "git": {"branch": branch}}}


def codex_item(ts, item):
    return {"timestamp": ts, "type": "event_msg", "payload": {"type": "item_completed", "item": item}}


def codex_user(ts, text):
    return codex_item(ts, {"type": "UserMessage", "id": "u",
                           "content": [{"type": "text", "text": text, "text_elements": []}]})


def codex_agent(ts, text):
    return codex_item(ts, {"type": "AgentMessage", "id": "a", "phase": "final_answer",
                           "content": [{"type": "Text", "text": text}]})


def codex_file_change(ts, paths):
    return codex_item(ts, {"type": "FileChange", "id": "f", "status": "completed",
                           "changes": {p: {"type": "update", "unified_diff": "@@"} for p in paths}})


class TimeTests(unittest.TestCase):
    def test_parse_ts_utc_z(self):
        ts = sessions.parse_ts("2026-09-15T14:00:00.123Z")
        self.assertEqual(ts, datetime(2026, 9, 15, 14, 0, 0, 123000, tzinfo=timezone.utc))

    def test_parse_ts_naive_is_local(self):
        ts = sessions.parse_ts("2026-09-15T10:00:00")
        self.assertEqual(ts.utcoffset(), timedelta(hours=-4))

    def test_parse_ts_rejects_garbage(self):
        self.assertIsNone(sessions.parse_ts("not a date"))
        self.assertIsNone(sessions.parse_ts(None))
        self.assertIsNone(sessions.parse_ts(12345))

    def test_window_is_local_and_inclusive(self):
        start, end = sessions.date_window("2026-09-14", "2026-09-20")
        self.assertEqual(start.isoformat(), "2026-09-14T00:00:00-04:00")
        self.assertEqual((end.hour, end.minute, end.second), (23, 59, 59))
        self.assertEqual(end.date().isoformat(), "2026-09-20")

    def test_window_across_dst_end(self):
        start, end = sessions.date_window("2026-10-26", "2026-11-01")
        self.assertEqual(start.utcoffset(), timedelta(hours=-4))
        self.assertEqual(end.utcoffset(), timedelta(hours=-5))


class ReadJsonlTests(TempDirTestCase):
    def test_invalid_line_is_skipped_and_counted(self):
        path = write_jsonl(self.tmp / "a.jsonl", [{"a": 1}, "{not json", {"b": 2}])
        stats = {"skipped_lines": 0}
        self.assertEqual(list(sessions.read_jsonl(path, stats)), [{"a": 1}, {"b": 2}])
        self.assertEqual(stats["skipped_lines"], 1)

    def test_partial_trailing_line_is_skipped(self):
        path = self.tmp / "live.jsonl"
        path.write_text('{"a": 1}\n{"type": "us', encoding="utf-8")
        stats = {"skipped_lines": 0}
        self.assertEqual(list(sessions.read_jsonl(path, stats)), [{"a": 1}])
        self.assertEqual(stats["skipped_lines"], 1)

    def test_non_utf8_bytes_do_not_crash(self):
        path = self.tmp / "bytes.jsonl"
        path.write_bytes(b'{"text": "caf\xff"}\n{"b": 2}\n')
        stats = {"skipped_lines": 0}
        records = list(sessions.read_jsonl(path, stats))
        self.assertEqual(len(records), 2)
        self.assertEqual(records[1], {"b": 2})

    def test_non_object_line_is_skipped(self):
        path = write_jsonl(self.tmp / "a.jsonl", ["[1, 2]", {"a": 1}])
        stats = {"skipped_lines": 0}
        self.assertEqual(list(sessions.read_jsonl(path, stats)), [{"a": 1}])
        self.assertEqual(stats["skipped_lines"], 1)

    def test_missing_file_yields_nothing(self):
        stats = {"skipped_lines": 0}
        self.assertEqual(list(sessions.read_jsonl(self.tmp / "nope.jsonl", stats)), [])


class PathTests(unittest.TestCase):
    def test_abbreviate(self):
        self.assertEqual(sessions.abbreviate("/home/dev/Code/x", HOME), "~/Code/x")
        self.assertEqual(sessions.abbreviate("/home/dev", HOME), "~")
        self.assertEqual(sessions.abbreviate("/home/devother/x", HOME), "/home/devother/x")
        self.assertEqual(sessions.abbreviate("/private/tmp", HOME), "/private/tmp")

    def test_is_excluded_matches_path_components(self):
        excludes = ["/home/dev/Code/beads", "/private/tmp"]
        self.assertTrue(sessions.is_excluded("/home/dev/Code/beads", excludes))
        self.assertTrue(sessions.is_excluded("/home/dev/Code/beads/sub/dir", excludes))
        self.assertTrue(sessions.is_excluded("/private/tmp/claude-1/x", excludes))
        self.assertFalse(sessions.is_excluded("/home/dev/Code/beadsmith", excludes))
        self.assertFalse(sessions.is_excluded("/home/dev/Code", excludes))

    def test_is_excluded_empty_list(self):
        self.assertFalse(sessions.is_excluded(CWD, []))

    def test_derive_repo_plain(self):
        self.assertEqual(sessions.derive_repo(CWD, REPOS), ("acme/api-service", None))

    def test_derive_repo_trailing_slash_repos_dir(self):
        self.assertEqual(sessions.derive_repo(CWD, REPOS + "/"), ("acme/api-service", None))

    def test_derive_repo_claude_worktree(self):
        cwd = CWD + "/.claude/worktrees/add-retries"
        self.assertEqual(sessions.derive_repo(cwd, REPOS), ("acme/api-service", "add-retries"))

    def test_derive_repo_codex_worktree_with_subdir(self):
        cwd = CWD + "/.worktrees/fix-certs/stacks/deploy"
        self.assertEqual(sessions.derive_repo(cwd, REPOS), ("acme/api-service", "fix-certs"))

    def test_derive_repo_outside_repos_dir(self):
        self.assertEqual(sessions.derive_repo("/home/dev/Desktop", REPOS), (None, None))
        self.assertEqual(sessions.derive_repo(REPOS, REPOS), (None, None))


class ActivityTests(unittest.TestCase):
    def _at(self, minutes):
        return datetime(2026, 9, 15, 14, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)

    def test_active_minutes_sums_short_gaps(self):
        times = [self._at(m) for m in (0, 10, 25)]
        self.assertEqual(sessions.active_minutes(times), 25)

    def test_active_minutes_ignores_idle_gaps(self):
        times = [self._at(m) for m in (0, 10, 100, 105)]  # 90-minute gap is idle
        self.assertEqual(sessions.active_minutes(times), 15)

    def test_active_minutes_unsorted_and_single(self):
        self.assertEqual(sessions.active_minutes([self._at(20), self._at(0)]), 20)
        self.assertEqual(sessions.active_minutes([self._at(0)]), 0)
        self.assertEqual(sessions.active_minutes([]), 0)


class SelectPromptsTests(unittest.TestCase):
    def test_eight_or_fewer_kept(self):
        prompts = [f"p{i}" for i in range(8)]
        self.assertEqual(sessions.select_prompts(prompts), (prompts, False))

    def test_first_five_last_three(self):
        prompts = [f"p{i}" for i in range(12)]
        chosen, truncated = sessions.select_prompts(prompts)
        self.assertEqual(chosen, ["p0", "p1", "p2", "p3", "p4", "p9", "p10", "p11"])
        self.assertTrue(truncated)

    def test_long_prompt_is_cut(self):
        chosen, truncated = sessions.select_prompts(["x" * 500])
        self.assertEqual(len(chosen[0]), sessions.PROMPT_CHARS)
        self.assertTrue(truncated)

    def test_first_only_stage(self):
        prompts = [f"p{i}" for i in range(4)]
        self.assertEqual(sessions.select_prompts(prompts, 1, 0), (["p0"], True))


class ClaudePromptTextTests(unittest.TestCase):
    def test_plain_string(self):
        self.assertEqual(sessions.claude_prompt_text("  fix the flaky deploy  "), "fix the flaky deploy")

    def test_text_blocks(self):
        content = [{"type": "text", "text": "look at this"}, {"type": "image", "source": {}}]
        self.assertEqual(sessions.claude_prompt_text(content), "look at this")

    def test_tool_result_is_not_a_prompt(self):
        content = [{"type": "tool_result", "tool_use_id": "x", "content": "output"}]
        self.assertIsNone(sessions.claude_prompt_text(content))

    def test_harness_text_is_not_a_prompt(self):
        for text in (
            "<local-command-caveat>Caveat: generated by local commands</local-command-caveat>",
            "<local-command-stdout>Connected.</local-command-stdout>",
            "<bash-stdout>ok</bash-stdout>",
            "<task-notification><task-id>1</task-id></task-notification>",
            "[Request interrupted by user for tool use]",
            "<system-reminder>only a reminder</system-reminder>",
        ):
            self.assertIsNone(sessions.claude_prompt_text(text), text)

    def test_appended_system_reminder_is_stripped(self):
        text = "deploy the fix\n<system-reminder>\nbackground note\n</system-reminder>"
        self.assertEqual(sessions.claude_prompt_text(text), "deploy the fix")

    def test_slash_command_forms(self):
        name_first = ("<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n"
                      "<command-args></command-args>")
        message_first = ("<command-message>review</command-message>\n<command-name>/review</command-name>\n"
                         "<command-args>high</command-args>")
        self.assertEqual(sessions.claude_prompt_text(name_first), "/mcp")
        self.assertEqual(sessions.claude_prompt_text(message_first), "/review high")

    def test_non_text_content(self):
        self.assertIsNone(sessions.claude_prompt_text(None))
        self.assertIsNone(sessions.claude_prompt_text("   "))


class ClaudeParserTests(TempDirTestCase):
    def _parse(self, records, name="abc-123"):
        path = write_jsonl(self.tmp / "proj" / f"{name}.jsonl", records)
        return sessions.parse_claude_file(path, {"skipped_lines": 0})

    def test_interactive_session_events(self):
        session = self._parse([
            {"type": "ai-title", "aiTitle": "Old title", "sessionId": "abc-123"},
            claude_user("investigate the 502s", "2026-09-15T14:00:00Z"),
            claude_assistant("2026-09-15T14:05:00Z", text="Root cause: stale DNS.",
                             edits=[CWD + "/runbook.md"]),
            claude_user([{"type": "tool_result", "tool_use_id": "t", "content": "x"}],
                        "2026-09-15T14:06:00Z"),
            claude_user("<system-reminder>skill body</system-reminder>", "2026-09-15T14:07:00Z",
                        isMeta=True),
            claude_user("sidechain text", "2026-09-15T14:08:00Z", isSidechain=True),
            {"type": "ai-title", "aiTitle": "DNS 502 investigation", "sessionId": "abc-123"},
        ])
        self.assertEqual(session.tool, "claude")
        self.assertEqual(session.session_id, "abc-123")
        self.assertEqual(session.cwd, CWD)
        self.assertEqual(session.title, "DNS 502 investigation")
        prompts = [e.text for e in session.events if e.kind == "prompt"]
        self.assertEqual(prompts, ["investigate the 502s"])
        assistant = [e for e in session.events if e.kind == "assistant"]
        self.assertEqual(assistant[0].text, "Root cause: stale DNS.")
        self.assertEqual(assistant[0].files, (CWD + "/runbook.md",))
        self.assertEqual(assistant[0].branch, "main")
        self.assertEqual(len(session.events), 5)  # meta and sidechain become "other"

    def test_headless_session_is_dropped(self):
        session = self._parse([claude_user("Reply with exactly: OK", "2026-09-15T14:00:00Z",
                                           entrypoint="sdk-cli")])
        self.assertIsNone(session)

    def test_session_without_cwd_is_dropped(self):
        record = claude_user("hi", "2026-09-15T14:00:00Z")
        del record["cwd"]
        self.assertIsNone(self._parse([record]))


class CodexParserTests(TempDirTestCase):
    def _parse(self, records, titles=None, name="rollout-2026-09-15T10-00-00-cdx-1.jsonl"):
        path = write_jsonl(self.tmp / "sessions" / "2026" / "09" / "15" / name, records)
        return sessions.parse_codex_file(path, titles or {}, {"skipped_lines": 0})

    def test_current_format(self):
        session = self._parse([
            codex_meta("cdx-1"),
            {"timestamp": "2026-09-15T14:00:00Z", "type": "response_item",
             "payload": {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "# AGENTS.md instructions"}]}},
            codex_user("2026-09-15T14:00:01Z", "fix the gateway certs"),
            codex_agent("2026-09-15T14:10:00Z", "Added regional certificates."),
            codex_file_change("2026-09-15T14:09:00Z", [CWD + "/stacks/apps.yaml"]),
        ], titles={"cdx-1": "Gateway certs"})
        self.assertEqual((session.tool, session.session_id, session.cwd), ("codex", "cdx-1", CWD))
        self.assertEqual(session.title, "Gateway certs")
        self.assertEqual([e.text for e in session.events if e.kind == "prompt"],
                         ["fix the gateway certs"])
        self.assertEqual([e.text for e in session.events if e.kind == "assistant"],
                         ["Added regional certificates."])
        files = [f for e in session.events for f in e.files]
        self.assertEqual(files, [CWD + "/stacks/apps.yaml"])
        self.assertTrue(all(e.branch == "main" for e in session.events))

    def test_older_format(self):
        session = self._parse([
            codex_meta("cdx-1", source="vscode"),
            {"timestamp": "2026-08-06T20:26:48Z", "type": "event_msg",
             "payload": {"type": "user_message", "message": "review this branch"}},
            {"timestamp": "2026-08-06T20:27:00Z", "type": "event_msg",
             "payload": {"type": "agent_message", "message": "Two surfaces to review."}},
            {"timestamp": "2026-08-06T20:28:00Z", "type": "event_msg",
             "payload": {"type": "patch_apply_end", "changes": {CWD + "/a.yaml": {}}}},
        ])
        self.assertEqual([e.text for e in session.events if e.kind == "prompt"], ["review this branch"])
        self.assertEqual([e.text for e in session.events if e.kind == "assistant"],
                         ["Two surfaces to review."])
        self.assertEqual([f for e in session.events for f in e.files], [CWD + "/a.yaml"])

    def test_non_user_sessions_are_dropped(self):
        prompt = codex_user("2026-09-15T14:00:01Z", "hi")
        self.assertIsNone(self._parse([codex_meta("cdx-1", source="exec"), prompt]))
        subagent = codex_meta("cdx-1")
        subagent["payload"]["source"] = {"subagent": {"other": "guardian"}}
        self.assertIsNone(self._parse([subagent, prompt]))
        self.assertIsNone(self._parse([codex_meta("cdx-1", originator="Claude Code"), prompt]))
        self.assertIsNone(self._parse([codex_meta("cdx-1"), prompt],
                                      titles={"cdx-1": "Codex Companion Task: <task> review"}))

    def test_corrupt_first_line_drops_session(self):
        self.assertIsNone(self._parse(["{truncated", codex_user("2026-09-15T14:00:01Z", "hi")]))
        self.assertIsNone(self._parse([codex_user("2026-09-15T14:00:01Z", "hi")]))

    def test_cwd_falls_back_to_turn_context(self):
        meta = codex_meta("cdx-1", cwd="")
        session = self._parse([
            meta,
            {"timestamp": "2026-09-15T14:00:00Z", "type": "turn_context", "payload": {"cwd": CWD}},
            codex_user("2026-09-15T14:00:01Z", "hi"),
        ])
        self.assertEqual(session.cwd, CWD)

    def test_load_titles(self):
        index = write_jsonl(self.tmp / "session_index.jsonl", [
            {"id": "cdx-1", "thread_name": "Gateway certs", "updated_at": "2026-09-15T14:00:00Z"},
            {"id": "cdx-2"},
            "{bad",
        ])
        stats = {"skipped_lines": 0}
        self.assertEqual(sessions.load_codex_titles(index, stats), {"cdx-1": "Gateway certs"})
        self.assertEqual(sessions.load_codex_titles(self.tmp / "missing.jsonl", stats), {})


if __name__ == "__main__":
    unittest.main()
