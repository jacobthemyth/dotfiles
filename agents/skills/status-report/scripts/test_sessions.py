#!/usr/bin/env python3
"""Tests for sessions.py (Claude Code / Codex session digests)."""

import contextlib
import io
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


class CollectTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.claude = self.tmp / "claude" / "projects"
        self.codex = self.tmp / "codex" / "sessions"

    def claude_session(self, name, records, project="-home-dev-Code-acme-api-service"):
        return write_jsonl(self.claude / project / f"{name}.jsonl", records)

    def run_collect(self, start="2026-09-14", end="2026-09-20", excludes=(), size_limit=None):
        kwargs = {} if size_limit is None else {"size_limit": size_limit}
        return sessions.collect(start, end, self.claude, self.codex, list(excludes), REPOS, HOME, **kwargs)

    def test_entry_fields(self):
        self.claude_session("s1", [
            {"type": "ai-title", "aiTitle": "Retry work"},
            claude_user("add retries", "2026-09-15T14:00:00Z",
                        cwd=CWD + "/.claude/worktrees/add-retries", branch="devuser/add-retries"),
            claude_assistant("2026-09-15T14:20:00Z", text="Done. " + "y" * 2000,
                             edits=[CWD + "/a.py", CWD + "/a.py", CWD + "/b.py"],
                             cwd=CWD + "/.claude/worktrees/add-retries", branch="HEAD"),
        ])
        doc = self.run_collect()
        self.assertEqual(doc["date_range"], {"start": "2026-09-14", "end": "2026-09-20"})
        self.assertFalse(doc["size_trimmed"])
        [entry] = doc["sessions"]
        self.assertEqual(entry["tool"], "claude")
        self.assertEqual(entry["session_id"], "s1")
        self.assertEqual(entry["title"], "Retry work")
        self.assertEqual(entry["cwd"], "~/Code/acme/api-service/.claude/worktrees/add-retries")
        self.assertEqual((entry["repo"], entry["worktree"]), ("acme/api-service", "add-retries"))
        self.assertEqual(entry["branches"], ["devuser/add-retries"])
        self.assertEqual(entry["first_prompt_at"], "2026-09-15T10:00:00-04:00")
        self.assertEqual(entry["last_prompt_at"], "2026-09-15T10:00:00-04:00")
        self.assertEqual(entry["active_minutes"], 20)
        self.assertEqual(entry["prompt_count"], 1)
        self.assertEqual(entry["prompts"], ["add retries"])
        self.assertFalse(entry["prompts_truncated"])
        self.assertEqual(len(entry["final_assistant_message"]), sessions.FINAL_CHARS)
        self.assertEqual(entry["files_touched"], ["~/Code/acme/api-service/a.py", "~/Code/acme/api-service/b.py"])
        self.assertFalse(any(key.startswith("_") for key in entry))

    def test_files_touched_capped(self):
        edits = [f"{CWD}/f{i}.py" for i in range(30)]
        self.claude_session("s1", [claude_user("go", "2026-09-15T14:00:00Z"),
                                   claude_assistant("2026-09-15T14:01:00Z", text="ok", edits=edits)])
        [entry] = self.run_collect()["sessions"]
        self.assertEqual(len(entry["files_touched"]), sessions.MAX_FILES)

    def test_session_split_across_weeks_at_local_midnight(self):
        self.claude_session("s1", [
            claude_user("sunday night", "2026-09-21T03:50:00Z"),   # Sun 23:50 EDT
            claude_user("monday morning", "2026-09-21T04:10:00Z"),  # Mon 00:10 EDT
        ])
        week1 = self.run_collect("2026-09-14", "2026-09-20")["sessions"]
        week2 = self.run_collect("2026-09-21", "2026-09-27")["sessions"]
        self.assertEqual(week1[0]["prompts"], ["sunday night"])
        self.assertEqual(week2[0]["prompts"], ["monday morning"])

    def test_no_in_range_prompt_is_dropped(self):
        self.claude_session("s1", [
            claude_user("last week", "2026-09-10T14:00:00Z"),
            claude_assistant("2026-09-15T14:00:00Z", text="late reply"),
        ])
        self.assertEqual(self.run_collect()["sessions"], [])

    def test_denylist(self):
        self.claude_session("s1", [claude_user("personal", "2026-09-15T14:00:00Z",
                                                cwd="/home/dev/Code/beads")])
        self.claude_session("s2", [claude_user("work", "2026-09-15T14:00:00Z",
                                                cwd="/home/dev/Code/beadsmith")])
        doc = self.run_collect(excludes=["/home/dev/Code/beads"])
        self.assertEqual([e["session_id"] for e in doc["sessions"]], ["s2"])

    def test_subagent_transcripts_are_not_read(self):
        write_jsonl(self.claude / "-home-dev-Code-acme-api-service" / "s1" / "subagents" / "agent-1.jsonl",
                    [claude_user("subagent task", "2026-09-15T14:00:00Z")])
        self.assertEqual(self.run_collect()["sessions"], [])

    def test_codex_and_claude_merged_in_time_order(self):
        self.claude_session("late", [claude_user("second", "2026-09-16T14:00:00Z")])
        write_jsonl(self.codex / "2026" / "09" / "15" / "rollout-x-cdx-1.jsonl",
                    [codex_meta("cdx-1"), codex_user("2026-09-15T14:00:00Z", "first")])
        doc = self.run_collect()
        self.assertEqual([e["session_id"] for e in doc["sessions"]], ["cdx-1", "late"])
        self.assertEqual(doc["sessions"][0]["tool"], "codex")

    def test_old_files_are_not_opened(self):
        path = self.claude_session("s1", [claude_user("go", "2026-09-15T14:00:00Z")])
        old = datetime(2026, 9, 1).timestamp()
        os.utime(path, (old, old))
        self.assertEqual(self.run_collect()["sessions"], [])

    def test_size_cap_trims_prompts_never_entries(self):
        for n in range(3):
            self.claude_session(f"s{n}", [claude_user(f"prompt {i} " + "z" * 290, f"2026-09-15T14:{i:02d}:00Z")
                                          for i in range(10)])
        full = self.run_collect()
        self.assertFalse(full["size_trimmed"])
        self.assertTrue(all(len(e["prompts"]) == 8 for e in full["sessions"]))
        trimmed = self.run_collect(size_limit=1)
        self.assertTrue(trimmed["size_trimmed"])
        self.assertEqual(len(trimmed["sessions"]), 3)
        self.assertTrue(all(len(e["prompts"]) == 1 and e["prompts_truncated"] for e in trimmed["sessions"]))

    def test_skipped_lines_reported(self):
        self.claude_session("s1", [claude_user("go", "2026-09-15T14:00:00Z"), "{broken"])
        self.assertEqual(self.run_collect()["skipped_lines"], 1)

    def test_missing_source_dirs(self):
        self.assertEqual(self.run_collect()["sessions"], [])

    def test_main_writes_output(self):
        self.claude_session("s1", [claude_user("go", "2026-09-15T14:00:00Z")])
        out = self.tmp / "out" / "sessions.json"
        out.parent.mkdir()
        code = sessions.main([
            "--start-date", "2026-09-14", "--end-date", "2026-09-20",
            "--claude-dir", str(self.claude), "--codex-dir", str(self.codex),
            "--exclude-paths", "/home/dev/Code/beads,,", "--repos-dir", REPOS,
            "--output", str(out),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(out.read_text())["sessions"]), 1)

    def test_main_rejects_bad_arguments(self):
        with self.assertRaises(SystemExit):
            sessions.main(["--start-date", "2026-09-14", "--end-date", "2026-09-20"])  # no --output
        with self.assertRaises(SystemExit):
            sessions.main(["--start-date", "2026-9-xx", "--end-date", "2026-09-20", "--output", "x"])

    def test_main_unwritable_output(self):
        code = sessions.main(["--start-date", "2026-09-14", "--end-date", "2026-09-20",
                              "--claude-dir", str(self.claude), "--codex-dir", str(self.codex),
                              "--output", str(self.tmp / "no" / "such" / "dir" / "x.json")])
        self.assertEqual(code, 1)


class ExpandTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.claude = self.tmp / "claude" / "projects"
        self.codex = self.tmp / "codex" / "sessions"
        write_jsonl(self.claude / "-home-dev-Code-acme-api-service" / "s1.jsonl", [
            {"type": "ai-title", "aiTitle": "DNS 502s"},
            claude_user("old question", "2026-09-10T14:00:00Z"),
            claude_user("why the 502s?", "2026-09-15T14:00:00Z"),
            {"type": "assistant", "timestamp": "2026-09-15T14:01:00Z", "cwd": CWD, "entrypoint": "cli",
             "message": {"content": [{"type": "tool_use", "name": "Bash",
                                      "input": {"command": "SECRET_TOOL_INPUT"}}]}},
            claude_user([{"type": "tool_result", "tool_use_id": "t", "content": "SECRET_TOOL_OUTPUT"}],
                        "2026-09-15T14:02:00Z"),
            claude_assistant("2026-09-15T14:03:00Z", text="Stale DNS cache."),
        ])
        write_jsonl(self.codex / "2026" / "09" / "15" / "rollout-2026-09-15T10-00-00-cdx-1.jsonl",
                    [codex_meta("cdx-1"), codex_user("2026-09-15T14:00:00Z", "codex prompt")])

    def expand(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sessions.main(["--claude-dir", str(self.claude), "--codex-dir", str(self.codex), *extra])
        return code, out.getvalue(), err.getvalue()

    def test_claude_transcript_has_no_tool_traffic(self):
        code, out, _ = self.expand("--expand", "s1")
        self.assertEqual(code, 0)
        self.assertIn("title: DNS 502s", out)
        self.assertIn("USER [2026-09-15 10:00]:\nwhy the 502s?", out)
        self.assertIn("ASSISTANT:\nStale DNS cache.", out)
        self.assertIn("old question", out)
        self.assertNotIn("SECRET_TOOL_INPUT", out)
        self.assertNotIn("SECRET_TOOL_OUTPUT", out)

    def test_date_filter(self):
        code, out, _ = self.expand("--expand", "s1", "--start-date", "2026-09-14", "--end-date", "2026-09-20")
        self.assertEqual(code, 0)
        self.assertNotIn("old question", out)
        self.assertIn("why the 502s?", out)

    def test_codex_by_id(self):
        code, out, _ = self.expand("--expand", "cdx-1")
        self.assertEqual(code, 0)
        self.assertIn("# codex session cdx-1", out)
        self.assertIn("codex prompt", out)

    def test_unknown_id(self):
        code, out, err = self.expand("--expand", "nope")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("session not found: nope", err)

    def test_half_a_date_range_is_rejected(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            sessions.main(["--expand", "s1", "--start-date", "2026-09-14"])


class ReviewFixTests(TempDirTestCase):
    """Regressions from the final whole-branch review."""

    def setUp(self):
        super().setUp()
        self.claude = self.tmp / "claude" / "projects"
        self.codex = self.tmp / "codex" / "sessions"

    def claude_session(self, name, records):
        return write_jsonl(self.claude / "-home-dev-Code-acme-api-service" / f"{name}.jsonl", records)

    def run_collect(self, excludes=(), **kwargs):
        return sessions.collect("2026-09-14", "2026-09-20", self.claude, self.codex,
                                list(excludes), REPOS, HOME, **kwargs)

    def test_compaction_summaries_and_system_origins_are_not_prompts(self):
        self.claude_session("s1", [
            claude_user("real prompt", "2026-09-15T14:00:00Z"),
            claude_user("This session is being continued from a previous conversation...",
                        "2026-09-15T14:01:00Z", isCompactSummary=True),
            claude_user("transcript-only text", "2026-09-15T14:02:00Z", isVisibleInTranscriptOnly=True),
            claude_user("queued notification text", "2026-09-15T14:03:00Z",
                        origin={"kind": "task-notification"}),
            claude_user("typed with origin", "2026-09-15T14:04:00Z", origin={"kind": "human"}),
        ])
        [entry] = self.run_collect()["sessions"]
        self.assertEqual(entry["prompts"], ["real prompt", "typed with origin"])
        self.assertEqual(entry["prompt_count"], 2)

    def test_session_relocated_into_excluded_path_is_dropped(self):
        self.claude_session("s1", [
            claude_user("start in work repo", "2026-09-15T14:00:00Z"),
            claude_user("now personal", "2026-09-15T14:05:00Z", cwd="/home/dev/Code/beads"),
        ])
        self.assertEqual(self.run_collect(excludes=["/home/dev/Code/beads"])["sessions"], [])

    def test_size_cap_trims_final_message_last(self):
        for n in range(3):
            self.claude_session(f"s{n}", [claude_user("go", "2026-09-15T14:00:00Z"),
                                          claude_assistant("2026-09-15T14:01:00Z", text="r" * 3000)])
        full = self.run_collect()
        self.assertTrue(all(len(e["final_assistant_message"]) == sessions.FINAL_CHARS
                            for e in full["sessions"]))
        trimmed = self.run_collect(size_limit=1)
        self.assertEqual(len(trimmed["sessions"]), 3)
        self.assertTrue(all(len(e["final_assistant_message"]) == 200 for e in trimmed["sessions"]))

    def test_expand_output_is_bounded_and_keeps_head_and_conclusion(self):
        records = []
        for i in range(60):
            records.append(claude_user(f"prompt {i} " + "p" * 5000, f"2026-09-15T14:{i:02d}:00Z"))
            records.append(claude_assistant(f"2026-09-15T14:{i:02d}:30Z", text=f"reply {i} " + "a" * 5000))
        records.append(claude_assistant("2026-09-15T15:30:00Z", text="FINAL CONCLUSION"))
        self.claude_session("big", records)
        session = sessions.find_session("big", self.claude, self.codex, {"skipped_lines": 0})
        out = sessions.render_transcript(session, None, None, HOME, max_chars=20000)
        self.assertLessEqual(len(out), 20000)
        self.assertIn("prompt 0 ", out)
        self.assertIn("FINAL CONCLUSION", out)
        self.assertRegex(out, r"\[\.\.\. \d+ turns omitted \.\.\.\]")
        small = sessions.render_transcript(session, None, None, HOME)
        self.assertLessEqual(len(small), sessions.EXPAND_MAX_CHARS)

    def test_expand_cli_accepts_max_chars(self):
        self.claude_session("s1", [claude_user("go " + "x" * 5000, "2026-09-15T14:00:00Z")])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = sessions.main(["--claude-dir", str(self.claude), "--codex-dir", str(self.codex),
                                  "--expand", "s1", "--max-chars", "1000"])
        self.assertEqual(code, 0)
        self.assertLessEqual(len(out.getvalue()), 1001)  # print adds a newline


if __name__ == "__main__":
    unittest.main()
