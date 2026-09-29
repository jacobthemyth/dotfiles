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


if __name__ == "__main__":
    unittest.main()
