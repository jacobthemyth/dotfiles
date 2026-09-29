# Status Report: Agent Sessions Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the user's local Claude Code and Codex sessions as a status-report source, make Slack optional, restore `/status-report` discovery, then backfill the missing weekly reports.

**Architecture:** A new stdlib-only collector, `scripts/sessions.py`, streams session JSONL files and turns each qualifying session into a compact summary entry. `collect.sh` runs it next to the existing collectors and merges its output into `combined.json`. The agent, following `SKILL.md`, matches sessions to PRs and commits, deep-reads up to 3 unmatched sessions per report via `sessions.py --expand`, and writes the report following `report-style.md`.

**Tech Stack:** Python 3 (stdlib only: `argparse`, `json`, `dataclasses`, `datetime`, `pathlib`, `re`), `unittest`, bash + `jq` (`collect.sh`), Markdown (skill docs).

**Spec:** `docs/superpowers/specs/2026-09-29-status-report-sessions-design.md` (read the Amendment block at the top first).

All paths below are relative to the `~/.dotfiles` repo root unless they start with `~`.
The skill lives at `agents/skills/status-report/`, and `~/.agents/skills/status-report`
is an rcm symlink to that directory. If you work in a git worktree, run tests from the
worktree. Tasks 7–9 also run the live skill, which reads the **main checkout**; do those
only after the branch is merged, or run the worktree's `collect.sh` directly as shown.

## Global Constraints

- `~/.dotfiles` is a **public** repo. Fixtures, examples and commit messages use only sanitized names (`acme/…`, `devuser`, `/home/dev`). No real org repos, colleague names, incident IDs or personal paths other than `~/.dotfiles`.
- The real config `~/.config/status-report/config.json` is untracked. It is edited in place and never committed.
- `sessions.py` uses the Python standard library only, like `github.py` and `documents.py`.
- Truncation limits: prompt 300 chars; final assistant message 1500 chars; files touched max 20; first 5 + last 3 prompts; idle gap 30 minutes; output size cap 200 KB (200,000 characters of `json.dumps(..., indent=2)`).
- Size-cap stages: (5 first, 3 last) → (3, 1) → (1, 0). Entries are never dropped.
- Deep reads: a group qualifies at total `active_minutes` ≥ 45 **or** total `prompt_count` ≥ 10; at most 3 groups per report.
- Codex sessions are kept only if `session_meta.payload.source` is `"cli"` or `"vscode"`, originator is not `"Claude Code"`, and the thread name doesn't start with `"Codex Companion Task"`.
- Missing Slack file: do **not** ask. Add this line to the end summary: `No Slack summary for this week (slack-<START_DATE>.md); add one and re-run to include it.`
- Commit only the files each task names (`git add <paths>` or `git commit -- <paths>`). The repo has unrelated uncommitted work. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A session file being written during collection** (the live session itself) ends in a partial JSON line. Expect it to be skipped and counted, not a crash. Tested in Task 2 (`test_partial_trailing_line_is_skipped`).
- **Non-UTF-8 bytes in a transcript** (pasted binary, a broken terminal paste). Expect the file to decode with replacement characters and keep parsing. Tested in Task 2 (`test_non_utf8_bytes_do_not_crash`).
- **A real prompt with a `<system-reminder>` block appended** by the harness. Expect the prompt kept with the reminder removed. Tested in Task 3 (`test_appended_system_reminder_is_stripped`).
- **The week containing the DST change** (2026-10-26 → 2026-11-01). Expect the window to start at local midnight EDT and end at 23:59:59 EST. Tested in Task 2 (`test_window_across_dst_end`).
- **A Codex file whose first line is corrupt or not `session_meta`** (truncated copy, format change). Expect the session dropped quietly. Tested in Task 4 (`test_corrupt_first_line_drops_session`).

---

### Task 1: Restore `/status-report` discovery

**Files:**
- Create (symlink, outside the repo): `~/.claude/skills/status-report -> ../../.agents/skills/status-report`

**Interfaces:**
- Consumes: nothing.
- Produces: `~/.claude/skills/status-report/…` paths resolve. `SKILL.md` and Tasks 7–9 use `~/.claude/skills/status-report/scripts/collect.sh`.

- [ ] **Step 1: Confirm the target exists and the link does not**

Run: `readlink ~/.agents/skills/status-report; ls -la ~/.claude/skills/status-report`
Expected: first line `/Users/jake/.dotfiles/agents/skills/status-report`; second prints `No such file or directory`.

- [ ] **Step 2: Create the link (same relative style as the neighboring `difit` links)**

```bash
ln -s ../../.agents/skills/status-report ~/.claude/skills/status-report
```

- [ ] **Step 3: Verify it resolves**

Run: `head -3 ~/.claude/skills/status-report/SKILL.md && ls ~/.claude/skills/status-report/scripts/collect.sh`
Expected: the frontmatter `---` / `name: status-report` lines and the collect.sh path.

No commit (the link is outside the repo).

---

### Task 2: `sessions.py` foundations (model, time, paths, prompt selection)

**Files:**
- Create: `agents/skills/status-report/scripts/sessions.py`
- Test: `agents/skills/status-report/scripts/test_sessions.py`

**Interfaces:**
- Produces (used by Tasks 3–6):
  - `Event(ts: datetime, kind: str, text: str = "", files: Tuple[str, ...] = (), branch: Optional[str] = None)`, where `kind` is `"prompt"`, `"assistant"` or `"other"`
  - `Session(tool: str, session_id: str, cwd: str, title: Optional[str] = None, events: List[Event] = [])`
  - `parse_ts(value) -> Optional[datetime]` (always timezone-aware)
  - `date_window(start_date: str, end_date: str) -> Tuple[datetime, datetime]` (local, inclusive)
  - `read_jsonl(path: Path, stats: Dict[str, int]) -> Iterator[dict]` (increments `stats["skipped_lines"]`)
  - `abbreviate(path: str, home: str) -> str`
  - `is_excluded(cwd: str, exclude_paths: List[str]) -> bool`
  - `derive_repo(cwd: str, repos_dir: str) -> Tuple[Optional[str], Optional[str]]` (repo, worktree)
  - `active_minutes(times: List[datetime]) -> int`
  - `select_prompts(prompts: List[str], head: int = 5, tail: int = 3) -> Tuple[List[str], bool]`
  - constants `PROMPT_CHARS, FINAL_CHARS, MAX_FILES, HEAD_PROMPTS, TAIL_PROMPTS, IDLE_GAP, SIZE_LIMIT, WORKTREE_MARKERS`

- [ ] **Step 1: Write the failing tests**

Create `agents/skills/status-report/scripts/test_sessions.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: ERROR, `FileNotFoundError`/`No such file or directory` for `sessions.py`.

- [ ] **Step 3: Write the implementation**

Create `agents/skills/status-report/scripts/sessions.py`:

```python
#!/usr/bin/env python3
"""
Agent Sessions Collector for Status Reports

Scans local Claude Code and Codex session transcripts, keeps the sessions the
user typed into during the report period, and emits one compact digest per
session as JSON. With --expand, prints a single session as a readable
transcript instead (prompts and assistant replies only).
"""

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

PROMPT_CHARS = 300
FINAL_CHARS = 1500
MAX_FILES = 20
HEAD_PROMPTS = 5
TAIL_PROMPTS = 3
IDLE_GAP = timedelta(minutes=30)
SIZE_LIMIT = 200_000
WORKTREE_MARKERS = ("/.claude/worktrees/", "/.worktrees/")


@dataclass
class Event:
    ts: datetime
    kind: str  # "prompt", "assistant", or "other"
    text: str = ""
    files: Tuple[str, ...] = ()
    branch: Optional[str] = None


@dataclass
class Session:
    tool: str
    session_id: str
    cwd: str
    title: Optional[str] = None
    events: List[Event] = field(default_factory=list)


def parse_ts(value: Any) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp; naive values are taken as local time."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.astimezone()


def date_window(start_date: str, end_date: str) -> Tuple[datetime, datetime]:
    """Local-time window from start_date 00:00:00 through end_date 23:59:59.999999."""
    start = datetime.strptime(start_date, "%Y-%m-%d").astimezone()
    end = (
        datetime.strptime(end_date, "%Y-%m-%d")
        .replace(hour=23, minute=59, second=59, microsecond=999999)
        .astimezone()
    )
    return start, end


def _skip(stats: Dict[str, int]) -> None:
    stats["skipped_lines"] = stats.get("skipped_lines", 0) + 1


def read_jsonl(path: Path, stats: Dict[str, int]) -> Iterator[Dict[str, Any]]:
    """Yield JSON objects line by line; unparseable or non-object lines are counted."""
    try:
        handle = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return
    with handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                _skip(stats)
                continue
            if isinstance(record, dict):
                yield record
            else:
                _skip(stats)


def abbreviate(path: str, home: str) -> str:
    """Replace a leading home directory with ~."""
    home = home.rstrip("/")
    if path == home:
        return "~"
    if path.startswith(home + "/"):
        return "~" + path[len(home):]
    return path


def is_excluded(cwd: str, exclude_paths: List[str]) -> bool:
    """True if cwd equals or is under any excluded prefix (compared by path component)."""
    cwd_parts = Path(os.path.normpath(cwd)).parts
    for prefix in exclude_paths:
        parts = Path(os.path.normpath(prefix)).parts
        if parts and cwd_parts[: len(parts)] == parts:
            return True
    return False


def derive_repo(cwd: str, repos_dir: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (repo relative to repos_dir, worktree name), stripping worktree suffixes."""
    base, worktree = cwd, None
    for marker in WORKTREE_MARKERS:
        if marker in base:
            base, rest = base.split(marker, 1)
            worktree = rest.split("/", 1)[0] or None
            break
    root = repos_dir.rstrip("/")
    if not base.startswith(root + "/"):
        return None, None
    return base[len(root) + 1 :].rstrip("/") or None, worktree


def active_minutes(times: List[datetime]) -> int:
    """Sum gaps between consecutive records, ignoring gaps longer than IDLE_GAP."""
    ordered = sorted(times)
    total = timedelta()
    for earlier, later in zip(ordered, ordered[1:]):
        gap = later - earlier
        if gap <= IDLE_GAP:
            total += gap
    return round(total.total_seconds() / 60)


def select_prompts(
    prompts: List[str], head: int = HEAD_PROMPTS, tail: int = TAIL_PROMPTS
) -> Tuple[List[str], bool]:
    """Keep the first `head` and last `tail` prompts, each cut to PROMPT_CHARS."""
    truncated = False
    if len(prompts) > head + tail:
        chosen = prompts[:head] + (prompts[-tail:] if tail else [])
        truncated = True
    else:
        chosen = list(prompts)
    result = []
    for prompt in chosen:
        if len(prompt) > PROMPT_CHARS:
            result.append(prompt[:PROMPT_CHARS])
            truncated = True
        else:
            result.append(prompt)
    return result, truncated
```

Then make it executable: `chmod +x agents/skills/status-report/scripts/sessions.py`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/status-report/scripts/sessions.py agents/skills/status-report/scripts/test_sessions.py
git commit -m "status-report: add sessions collector foundations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Claude Code session parser

**Files:**
- Modify: `agents/skills/status-report/scripts/sessions.py` (append after `select_prompts`)
- Test: `agents/skills/status-report/scripts/test_sessions.py` (add a fixture helper and a test class above `if __name__`)

**Interfaces:**
- Consumes: `Event`, `Session`, `parse_ts`, `read_jsonl` (Task 2).
- Produces: `claude_prompt_text(content) -> Optional[str]`, `parse_claude_file(path: Path, stats: Dict[str, int]) -> Optional[Session]`. Returns `None` for non-interactive sessions (no record with `entrypoint == "cli"`) or ones with no `cwd`. `session_id` is the file stem.

- [ ] **Step 1: Write the failing tests**

Add to `test_sessions.py`, after `TempDirTestCase`:

```python
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
```

Add this test class before `if __name__ == "__main__":`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: the new tests ERROR with `AttributeError: module 'sessions_collector' has no attribute 'claude_prompt_text'` (and `parse_claude_file`); the Task 2 tests still PASS.

- [ ] **Step 3: Write the implementation**

Append to `sessions.py`:

```python
# --- Claude Code -----------------------------------------------------------

# User-role text the harness injects, which the user never typed.
NON_PROMPT_PREFIXES = (
    "<local-command-",
    "<bash-stdout>",
    "<bash-stderr>",
    "<task-notification>",
    "[Request interrupted by user",
)
SYSTEM_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
CLAUDE_EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def _between(text: str, start_tag: str, end_tag: str) -> str:
    start = text.find(start_tag)
    if start < 0:
        return ""
    start += len(start_tag)
    end = text.find(end_tag, start)
    return text[start:end].strip() if end >= 0 else ""


def claude_prompt_text(content: Any) -> Optional[str]:
    """Return the typed prompt in a Claude user record's content, or None."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        blocks = [b for b in content if isinstance(b, dict)]
        if any(b.get("type") == "tool_result" for b in blocks):
            return None
        text = "\n".join(
            b["text"] for b in blocks if b.get("type") == "text" and isinstance(b.get("text"), str)
        )
    else:
        return None
    text = text.strip()
    if text.startswith("<command-"):
        name = _between(text, "<command-name>", "</command-name>")
        args = _between(text, "<command-args>", "</command-args>")
        return f"{name} {args}".strip() if name else None
    if text.startswith(NON_PROMPT_PREFIXES):
        return None
    text = SYSTEM_REMINDER_RE.sub("", text).strip()
    return text or None


def _claude_assistant_event(ts: datetime, content: Any, branch: Optional[str]) -> Event:
    texts: List[str] = []
    files: List[str] = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            texts.append(block["text"])
        elif block.get("type") == "tool_use" and block.get("name") in CLAUDE_EDIT_TOOLS:
            tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
            file_path = tool_input.get("file_path") or tool_input.get("notebook_path")
            if isinstance(file_path, str):
                files.append(file_path)
    text = "\n".join(texts).strip()
    return Event(ts, "assistant" if text else "other", text, tuple(files), branch)


def parse_claude_file(path: Path, stats: Dict[str, int]) -> Optional[Session]:
    """Parse one Claude Code transcript; None unless it is an interactive session."""
    session = Session(tool="claude", session_id=path.stem, cwd="")
    interactive = False
    for record in read_jsonl(path, stats):
        rtype = record.get("type")
        if rtype == "ai-title":
            if isinstance(record.get("aiTitle"), str) and record["aiTitle"]:
                session.title = record["aiTitle"]
            continue
        if record.get("entrypoint") == "cli":
            interactive = True
        if not session.cwd and isinstance(record.get("cwd"), str):
            session.cwd = record["cwd"]
        ts = parse_ts(record.get("timestamp"))
        if ts is None:
            continue
        branch = record.get("gitBranch") if isinstance(record.get("gitBranch"), str) else None
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        side = bool(record.get("isSidechain"))
        if rtype == "user" and not record.get("isMeta") and not side:
            text = claude_prompt_text(message.get("content"))
            if text:
                session.events.append(Event(ts, "prompt", text, branch=branch))
                continue
        elif rtype == "assistant" and not side:
            session.events.append(_claude_assistant_event(ts, message.get("content"), branch))
            continue
        session.events.append(Event(ts, "other", branch=branch))
    if not interactive or not session.cwd:
        return None
    return session
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/status-report/scripts/sessions.py agents/skills/status-report/scripts/test_sessions.py
git commit -m "status-report: parse Claude Code sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Codex session parser

**Files:**
- Modify: `agents/skills/status-report/scripts/sessions.py` (append after `parse_claude_file`)
- Test: `agents/skills/status-report/scripts/test_sessions.py`

**Interfaces:**
- Consumes: `Event`, `Session`, `parse_ts`, `read_jsonl` (Task 2).
- Produces:
  - `load_codex_titles(index_path: Path, stats) -> Dict[str, str]` (thread id → `thread_name`)
  - `parse_codex_file(path: Path, titles: Dict[str, str], stats) -> Optional[Session]`, with `session_id` taken from `session_meta.payload.id`
  - constant `CODEX_KEEP_SOURCES = ("cli", "vscode")`

- [ ] **Step 1: Write the failing tests**

Add these helpers to `test_sessions.py` after `claude_assistant`:

```python
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
```

Add this test class before `if __name__ == "__main__":`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: `CodexParserTests` ERROR with `AttributeError: … 'parse_codex_file'` / `'load_codex_titles'`; earlier tests PASS.

- [ ] **Step 3: Write the implementation**

Append to `sessions.py`:

```python
# --- Codex -----------------------------------------------------------------

CODEX_KEEP_SOURCES = ("cli", "vscode")
COMPANION_PREFIX = "Codex Companion Task"


def load_codex_titles(index_path: Path, stats: Dict[str, int]) -> Dict[str, str]:
    """Map Codex thread id -> thread_name from session_index.jsonl."""
    titles: Dict[str, str] = {}
    if index_path.is_file():
        for record in read_jsonl(index_path, stats):
            if isinstance(record.get("id"), str) and isinstance(record.get("thread_name"), str):
                titles[record["id"]] = record["thread_name"]
    return titles


def _codex_item_text(item: Dict[str, Any]) -> str:
    content = item.get("content") if isinstance(item.get("content"), list) else []
    return "\n".join(
        block["text"] for block in content
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ).strip()


def _codex_event(record: Dict[str, Any], ts: datetime, branch: Optional[str]) -> Event:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    if record.get("type") != "event_msg":
        return Event(ts, "other", branch=branch)
    ptype = payload.get("type")
    if ptype in ("user_message", "agent_message"):
        text = payload.get("message").strip() if isinstance(payload.get("message"), str) else ""
        if text:
            return Event(ts, "prompt" if ptype == "user_message" else "assistant", text, branch=branch)
    elif ptype == "patch_apply_end" and isinstance(payload.get("changes"), dict):
        return Event(ts, "other", files=tuple(payload["changes"]), branch=branch)
    elif ptype == "item_completed" and isinstance(payload.get("item"), dict):
        item = payload["item"]
        itype = item.get("type")
        if itype in ("UserMessage", "AgentMessage"):
            text = _codex_item_text(item)
            if text:
                return Event(ts, "prompt" if itype == "UserMessage" else "assistant", text, branch=branch)
        elif itype == "FileChange" and isinstance(item.get("changes"), dict):
            return Event(ts, "other", files=tuple(item["changes"]), branch=branch)
    return Event(ts, "other", branch=branch)


def parse_codex_file(path: Path, titles: Dict[str, str], stats: Dict[str, int]) -> Optional[Session]:
    """Parse one Codex rollout; None unless the user started it interactively."""
    session: Optional[Session] = None
    branch: Optional[str] = None
    for record in read_jsonl(path, stats):
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if session is None:
            if record.get("type") != "session_meta":
                return None
            if payload.get("source") not in CODEX_KEEP_SOURCES:
                return None
            if payload.get("originator") == "Claude Code":
                return None
            session_id = payload.get("id") if isinstance(payload.get("id"), str) else path.stem
            title = titles.get(session_id)
            if title and title.startswith(COMPANION_PREFIX):
                return None
            git = payload.get("git") if isinstance(payload.get("git"), dict) else {}
            branch = git.get("branch") if isinstance(git.get("branch"), str) else None
            cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
            session = Session("codex", session_id, cwd, title)
            continue
        if record.get("type") == "turn_context" and not session.cwd and isinstance(payload.get("cwd"), str):
            session.cwd = payload["cwd"]
        ts = parse_ts(record.get("timestamp"))
        if ts is not None:
            session.events.append(_codex_event(record, ts, branch))
    if session is None or not session.cwd:
        return None
    return session
```

Note: `read_jsonl` skips a corrupt first line, so the first *parsed* record is then a non-`session_meta` event and the session is dropped. That is the behavior `test_corrupt_first_line_drops_session` pins down.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/skills/status-report/scripts/sessions.py agents/skills/status-report/scripts/test_sessions.py
git commit -m "status-report: parse Codex sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Summary entries, output document, collect-mode CLI

**Files:**
- Modify: `agents/skills/status-report/scripts/sessions.py` (append after `parse_codex_file`)
- Test: `agents/skills/status-report/scripts/test_sessions.py`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces:
  - `build_entry(session: Session, start: datetime, end: datetime, repos_dir: str, home: str) -> Optional[dict]`. The entry carries private `_prompts` (all prompt texts) and `_sort` (datetime) keys that `build_document` removes.
  - `build_document(entries: List[dict], start_date: str, end_date: str, skipped_lines: int, size_limit: int = SIZE_LIMIT) -> dict`
  - `iter_sessions(claude_dir: Path, codex_dir: Path, since_ts: float, stats) -> Iterator[Session]`
  - `collect(start_date, end_date, claude_dir: Path, codex_dir: Path, exclude_paths: List[str], repos_dir: str, home: str, size_limit: int = SIZE_LIMIT) -> dict`
  - `main(argv: Optional[List[str]] = None) -> int`, with CLI flags `--start-date --end-date --claude-dir --codex-dir --exclude-paths --repos-dir --output`
  - Output JSON keys: `date_range{start,end}`, `skipped_lines`, `size_trimmed`, `sessions[]`. Each entry has `tool, session_id, title, cwd, repo, worktree, branches, first_prompt_at, last_prompt_at, active_minutes, prompt_count, prompts, prompts_truncated, final_assistant_message, files_touched`.

- [ ] **Step 1: Write the failing tests**

Add this test class before `if __name__ == "__main__":`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: `CollectTests` ERROR with `AttributeError: … 'collect'` / `'main'`; earlier tests PASS.

- [ ] **Step 3: Write the implementation**

Append to `sessions.py`:

```python
# --- Digest ----------------------------------------------------------------

TRIM_STAGES = ((HEAD_PROMPTS, TAIL_PROMPTS), (3, 1), (1, 0))


def _local_iso(ts: datetime) -> str:
    return ts.astimezone().isoformat(timespec="seconds")


def build_entry(
    session: Session, start: datetime, end: datetime, repos_dir: str, home: str
) -> Optional[Dict[str, Any]]:
    """Digest a session's in-range events; None if the user typed nothing in range."""
    events = sorted((e for e in session.events if start <= e.ts <= end), key=lambda e: e.ts)
    prompts = [e for e in events if e.kind == "prompt"]
    if not prompts:
        return None
    replies = [e for e in events if e.kind == "assistant" and e.text]
    files: List[str] = []
    branches: List[str] = []
    for event in events:
        for file_path in event.files:
            short = abbreviate(file_path, home)
            if short not in files:
                files.append(short)
        if event.branch and event.branch != "HEAD" and event.branch not in branches:
            branches.append(event.branch)
    repo, worktree = derive_repo(session.cwd, repos_dir)
    return {
        "tool": session.tool,
        "session_id": session.session_id,
        "title": session.title,
        "cwd": abbreviate(session.cwd, home),
        "repo": repo,
        "worktree": worktree,
        "branches": branches,
        "first_prompt_at": _local_iso(prompts[0].ts),
        "last_prompt_at": _local_iso(prompts[-1].ts),
        "active_minutes": active_minutes([e.ts for e in events]),
        "prompt_count": len(prompts),
        "prompts": [],
        "prompts_truncated": False,
        "final_assistant_message": replies[-1].text[:FINAL_CHARS] if replies else None,
        "files_touched": files[:MAX_FILES],
        "_prompts": [p.text for p in prompts],
        "_sort": prompts[0].ts,
    }


def build_document(
    entries: List[Dict[str, Any]],
    start_date: str,
    end_date: str,
    skipped_lines: int,
    size_limit: int = SIZE_LIMIT,
) -> Dict[str, Any]:
    """Assemble the output, trimming prompts in stages until it fits size_limit."""
    ordered = sorted(entries, key=lambda e: e["_sort"])
    document: Dict[str, Any] = {}
    for stage, (head, tail) in enumerate(TRIM_STAGES):
        for entry in ordered:
            entry["prompts"], entry["prompts_truncated"] = select_prompts(entry["_prompts"], head, tail)
        document = {
            "date_range": {"start": start_date, "end": end_date},
            "skipped_lines": skipped_lines,
            "size_trimmed": stage > 0,
            "sessions": [
                {k: v for k, v in entry.items() if not k.startswith("_")} for entry in ordered
            ],
        }
        if len(json.dumps(document, indent=2)) <= size_limit:
            break
    return document


def _modified_since(path: Path, since_ts: float) -> bool:
    try:
        return path.stat().st_mtime >= since_ts
    except OSError:
        return False


def iter_sessions(
    claude_dir: Path, codex_dir: Path, since_ts: float, stats: Dict[str, int]
) -> Iterator[Session]:
    """Yield qualifying sessions from files modified since since_ts."""
    if claude_dir.is_dir():
        # */*.jsonl is top-level transcripts only; subagents live one level deeper.
        for path in sorted(claude_dir.glob("*/*.jsonl")):
            if _modified_since(path, since_ts):
                session = parse_claude_file(path, stats)
                if session:
                    yield session
    if codex_dir.is_dir():
        titles = load_codex_titles(codex_dir.parent / "session_index.jsonl", stats)
        for path in sorted(codex_dir.rglob("*.jsonl")):
            if _modified_since(path, since_ts):
                session = parse_codex_file(path, titles, stats)
                if session:
                    yield session


def collect(
    start_date: str,
    end_date: str,
    claude_dir: Path,
    codex_dir: Path,
    exclude_paths: List[str],
    repos_dir: str,
    home: str,
    size_limit: int = SIZE_LIMIT,
) -> Dict[str, Any]:
    start, end = date_window(start_date, end_date)
    stats = {"skipped_lines": 0}
    entries = []
    for session in iter_sessions(claude_dir, codex_dir, start.timestamp(), stats):
        if is_excluded(session.cwd, exclude_paths):
            continue
        entry = build_entry(session, start, end, repos_dir, home)
        if entry:
            entries.append(entry)
    return build_document(entries, start_date, end_date, stats["skipped_lines"], size_limit)


# --- CLI -------------------------------------------------------------------

def _expand(path: str) -> str:
    return os.path.normpath(os.path.expanduser(path))


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect Claude Code and Codex session digests for status reports"
    )
    parser.add_argument("--start-date", help="YYYY-MM-DD (local time, inclusive)")
    parser.add_argument("--end-date", help="YYYY-MM-DD (local time, inclusive)")
    parser.add_argument("--claude-dir", default="~/.claude/projects")
    parser.add_argument("--codex-dir", default="~/.codex/sessions")
    parser.add_argument(
        "--exclude-paths", default="",
        help="Comma-separated path prefixes; sessions whose cwd is under one are dropped",
    )
    parser.add_argument("--repos-dir", default="~/Code", help="Root that repo names are relative to")
    parser.add_argument("--output", help="Output JSON file path")
    args = parser.parse_args(argv)
    if not (args.start_date and args.end_date and args.output):
        parser.error("--start-date, --end-date and --output are required")
    try:
        date_window(args.start_date, args.end_date)
    except ValueError as exc:
        parser.error(f"invalid date: {exc}")
    return args


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    home = str(Path.home())
    excludes = [_expand(p) for p in args.exclude_paths.split(",") if p.strip()]
    document = collect(
        args.start_date,
        args.end_date,
        Path(_expand(args.claude_dir)),
        Path(_expand(args.codex_dir)),
        excludes,
        _expand(args.repos_dir),
        home,
    )
    try:
        Path(args.output).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"Error writing {args.output}: {exc}", file=sys.stderr)
        return 1
    print(f"Collected {len(document['sessions'])} agent sessions", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: all tests PASS. (`test_main_rejects_bad_arguments` prints argparse usage to stderr; that is expected.)

- [ ] **Step 5: Commit**

```bash
git add agents/skills/status-report/scripts/sessions.py agents/skills/status-report/scripts/test_sessions.py
git commit -m "status-report: build session digests and collect CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Expand mode

**Files:**
- Modify: `agents/skills/status-report/scripts/sessions.py`: add `find_session` and `render_transcript` above the `# --- CLI` marker, and **replace** `parse_args` and `main` with the versions below.
- Test: `agents/skills/status-report/scripts/test_sessions.py`

**Interfaces:**
- Consumes: `parse_claude_file`, `parse_codex_file`, `load_codex_titles`, `date_window`, `abbreviate`, `Session`.
- Produces:
  - `find_session(session_id: str, claude_dir: Path, codex_dir: Path, stats) -> Optional[Session]`
  - `render_transcript(session: Session, start: Optional[datetime], end: Optional[datetime], home: str) -> str`
  - CLI: `sessions.py --expand SESSION_ID [--start-date D --end-date D] [--claude-dir] [--codex-dir]`. Prints to stdout and exits 0, or prints `session not found: <id>` to stderr and exits 1. SKILL.md (Task 8) calls this.

- [ ] **Step 1: Write the failing tests**

Add these imports at the top of `test_sessions.py`, next to the others:

```python
import contextlib
import io
```

Add this test class before `if __name__ == "__main__":`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: `ExpandTests` FAIL or ERROR, because `--expand` is an unrecognized argument (SystemExit 2) or `--output` is required; earlier tests PASS.

- [ ] **Step 3: Write the implementation**

Insert above the `# --- CLI ---` marker in `sessions.py`:

```python
# --- Expand ----------------------------------------------------------------

def find_session(
    session_id: str, claude_dir: Path, codex_dir: Path, stats: Dict[str, int]
) -> Optional[Session]:
    """Locate a qualifying session by id (Claude file stem, or Codex rollout id)."""
    if claude_dir.is_dir():
        for path in claude_dir.glob(f"*/{session_id}.jsonl"):
            session = parse_claude_file(path, stats)
            if session:
                return session
    if codex_dir.is_dir():
        titles = load_codex_titles(codex_dir.parent / "session_index.jsonl", stats)
        for path in codex_dir.rglob(f"*{session_id}.jsonl"):
            session = parse_codex_file(path, titles, stats)
            if session and session.session_id == session_id:
                return session
    return None


def render_transcript(
    session: Session, start: Optional[datetime], end: Optional[datetime], home: str
) -> str:
    """Plain-text transcript: typed prompts and assistant text only, no tool traffic."""
    events = sorted(
        (e for e in session.events if (start is None or start <= e.ts) and (end is None or e.ts <= end)),
        key=lambda e: e.ts,
    )
    branches = sorted({e.branch for e in events if e.branch and e.branch != "HEAD"})
    lines = [
        f"# {session.tool} session {session.session_id}",
        f"title: {session.title or '-'}",
        f"cwd: {abbreviate(session.cwd, home)}",
        f"branches: {', '.join(branches) or '-'}",
    ]
    if events:
        lines.append(f"span: {_local_iso(events[0].ts)} to {_local_iso(events[-1].ts)}")
    lines.append("")
    for event in events:
        if event.kind == "prompt":
            lines += [f"USER [{event.ts.astimezone():%Y-%m-%d %H:%M}]:", event.text, ""]
        elif event.kind == "assistant":
            lines += ["ASSISTANT:", event.text, ""]
    return "\n".join(lines)
```

Replace the whole `parse_args` and `main` functions with:

```python
def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect Claude Code and Codex session digests for status reports"
    )
    parser.add_argument("--start-date", help="YYYY-MM-DD (local time, inclusive)")
    parser.add_argument("--end-date", help="YYYY-MM-DD (local time, inclusive)")
    parser.add_argument("--claude-dir", default="~/.claude/projects")
    parser.add_argument("--codex-dir", default="~/.codex/sessions")
    parser.add_argument(
        "--exclude-paths", default="",
        help="Comma-separated path prefixes; sessions whose cwd is under one are dropped",
    )
    parser.add_argument("--repos-dir", default="~/Code", help="Root that repo names are relative to")
    parser.add_argument("--output", help="Output JSON file path")
    parser.add_argument(
        "--expand", metavar="SESSION_ID",
        help="Print one session as a readable transcript instead of collecting",
    )
    args = parser.parse_args(argv)
    if args.expand:
        if bool(args.start_date) != bool(args.end_date):
            parser.error("--start-date and --end-date must be given together")
    elif not (args.start_date and args.end_date and args.output):
        parser.error("--start-date, --end-date and --output are required")
    if args.start_date:
        try:
            date_window(args.start_date, args.end_date)
        except ValueError as exc:
            parser.error(f"invalid date: {exc}")
    return args


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    home = str(Path.home())
    claude_dir = Path(_expand(args.claude_dir))
    codex_dir = Path(_expand(args.codex_dir))

    if args.expand:
        session = find_session(args.expand, claude_dir, codex_dir, {"skipped_lines": 0})
        if session is None:
            print(f"session not found: {args.expand}", file=sys.stderr)
            return 1
        start, end = date_window(args.start_date, args.end_date) if args.start_date else (None, None)
        print(render_transcript(session, start, end, home))
        return 0

    excludes = [_expand(p) for p in args.exclude_paths.split(",") if p.strip()]
    document = collect(
        args.start_date, args.end_date, claude_dir, codex_dir, excludes, _expand(args.repos_dir), home
    )
    try:
        Path(args.output).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"Error writing {args.output}: {exc}", file=sys.stderr)
        return 1
    print(f"Collected {len(document['sessions'])} agent sessions", file=sys.stderr)
    return 0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 agents/skills/status-report/scripts/test_sessions.py -v`
Expected: all tests PASS. Also run `python3 agents/skills/status-report/scripts/test_github.py` and expect PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add agents/skills/status-report/scripts/sessions.py agents/skills/status-report/scripts/test_sessions.py
git commit -m "status-report: add sessions --expand transcript mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire into `collect.sh`, config, and live check

**Files:**
- Modify: `agents/skills/status-report/scripts/collect.sh` (header comment at lines 5–8; new block after the Documents block, before `# Note: Slack is NOT collected here.`; merge loop)
- Modify: `config/status-report/config.example.json`
- Modify (untracked, never commit): `~/.config/status-report/config.json`

**Interfaces:**
- Consumes: the `sessions.py` CLI from Tasks 5–6; `get_config`, `get_config_array`, `expand_path`, `log_*` from `lib/common.sh`; `$REPOS_DIR`, `$TEMP_DIR`, `$SCRIPT_DIR` already set in `collect.sh`.
- Produces: `combined.json.sessions` (the Task 5 document) whenever the collector succeeds. `SKILL.md` (Task 8) reads it.

- [ ] **Step 1: Update the header comment**

In `collect.sh`, replace:

```bash
# Resolves a date range, runs the deterministic collectors (github, git,
# documents, slack), and merges their output into combined.json.
```

with:

```bash
# Resolves a date range, runs the deterministic collectors (github, git,
# documents, agent sessions), and merges their output into combined.json.
```

- [ ] **Step 2: Add the collector block**

Insert immediately before the line `# Note: Slack is NOT collected here. The agent reads the week's Slack summary`:

```bash
# --- Agent sessions (Claude Code + Codex) ---
# Report output and the skill itself are always excluded so report-generation
# and skill-maintenance sessions never count as work. pwd -P gives the real
# path (sessions record resolved cwds, not the ~/.claude/skills symlink).
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SESSION_EXCLUDES="$(expand_path "$(get_config output_directory "$HOME/Desktop")"),$SKILL_DIR"
while IFS= read -r p; do
    [[ -n "$p" ]] && SESSION_EXCLUDES+=",$(expand_path "$p")"
done < <(get_config_array session_exclude_paths | jq -r '.[]')

log_info "Running agent sessions collector..."
if "$SCRIPT_DIR/sessions.py" --start-date "$START_DATE" --end-date "$END_DATE" \
    --exclude-paths "$SESSION_EXCLUDES" --repos-dir "$REPOS_DIR" \
    --output "$TEMP_DIR/sessions.json"; then
    SUCCESSFUL_COLLECTORS+=("sessions"); log_success "Agent sessions collected"
else
    log_warn "Sessions collector failed"
fi

```

- [ ] **Step 3: Add `sessions` to the merge loop**

Replace `for src in github git documents; do` with `for src in github git documents sessions; do`.

- [ ] **Step 4: Add the example config key**

In `config/status-report/config.example.json`, replace:

```json
  "output_directory": "~/Documents/status-report/reports"
}
```

with:

```json
  "output_directory": "~/Documents/status-report/reports",
  "session_exclude_paths": [
    "~/.dotfiles",
    "~/Code/personal",
    "~/Documents/status-report",
    "/private/tmp",
    "/tmp"
  ]
}
```

Verify: `jq . config/status-report/config.example.json` prints valid JSON.

- [ ] **Step 5: Add the real denylist to the untracked config**

```bash
cfg=~/.config/status-report/config.json
jq '.session_exclude_paths = ["~/.dotfiles", "~/Code/jacobthemyth", "~/Code/beads", "~/Desktop/bees", "~/Documents/status-report", "/private/tmp", "/tmp"]' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
jq .session_exclude_paths "$cfg"
```

Expected: the 7 paths are printed. `~/Desktop` and `~` must **not** be in the list (the user asked for this).

- [ ] **Step 6: Live check on a known week**

Run `collect.sh` from this checkout (the worktree if you're in one) with `bash agents/skills/status-report/scripts/collect.sh --start-date 2026-09-14 --end-date 2026-09-20`. Then, using the printed `WORK_DIR`:

```bash
W=<WORK_DIR>
jq '{n: (.sessions | length), skipped: .skipped_lines, trimmed: .size_trimmed}' "$W/sessions.json"
jq -r '.sessions[] | "\(.tool)\t\(.active_minutes)m\t\(.prompt_count)p\t\(.repo // .cwd)\t\(.title // "-")"' "$W/sessions.json" | sort -t$'\t' -k4
jq -r '.sessions[].cwd' "$W/sessions.json" | grep -E '\.dotfiles|jacobthemyth|/Code/beads|Desktop/bees|Documents/status-report|/tmp' || echo "no excluded paths: OK"
wc -c "$W/sessions.json"
jq 'has("sessions")' "$W/combined.json"
```

Expected:
- `n` is non-zero and far below the raw file count (tens, not hundreds)
- `skipped` is small
- no excluded paths appear ("no excluded paths: OK")
- the size is ≤ 200000
- `combined.json` has `sessions: true`
- work repos under `abridgeai/` appear

Pick one Claude and one Codex `session_id` and check expand mode: `python3 agents/skills/status-report/scripts/sessions.py --expand <id> --start-date 2026-09-14 --end-date 2026-09-20 | head -40`. It should show readable USER/ASSISTANT turns with no tool output. If any count looks wrong (e.g. Codex guardian threads appear, or `n` is 0), stop and investigate with superpowers:systematic-debugging before continuing.

- [ ] **Step 7: Commit (tracked files only)**

```bash
git add agents/skills/status-report/scripts/collect.sh config/status-report/config.example.json
git commit -m "status-report: run sessions collector from collect.sh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Skill instructions (SKILL.md, report-style.md)

**Files:**
- Modify: `agents/skills/status-report/SKILL.md`
- Modify: `agents/skills/status-report/reference/report-style.md`

**Interfaces:**
- Consumes: `combined.json.sessions` fields (Task 5); the `sessions.py --expand` CLI (Task 6); the collector path `~/.claude/skills/status-report/scripts/` (Task 1).
- Produces: the agent behavior the backfill (Task 9) relies on.

- [ ] **Step 1: Update the frontmatter description and intro**

In `SKILL.md`, replace the `description:` line with:

```yaml
description: Generate a status report of the user's work activity (GitHub, git, Linear, Google Calendar, documents, Claude Code and Codex sessions, Slack if available). Use when the user asks to "generate/create my status report", a "weekly status report", or a "monthly status report". Defaults to the previous full week.
```

Replace:

```markdown
Generate an executive-level status report from the user's work activity. Deterministic
sources are collected by a script; Linear and Google Calendar are collected by you via MCP;
you write the report.
```

with:

```markdown
Generate an executive-level status report from the user's work activity. Deterministic
sources (GitHub, git, documents, Claude Code and Codex sessions) are collected by a script;
Linear and Google Calendar are collected by you via MCP; you write the report.
```

In step 2, replace `it holds the github, git, and documents data plus the` `date_range`` with `it holds the github, git, documents, and sessions data plus the` `date_range``. That is, the sentence becomes: "Then read the `COMBINED_JSON` file — it holds the github, git, documents, and sessions data plus the `date_range`."

- [ ] **Step 2: Replace the Slack step's missing-file behavior**

In `## 5. Read the week's Slack summary`, replace the whole bullet that starts `- If the file is **missing**` (including its nested `- To help with (a)…` sub-bullet) with:

```markdown
- If the file is **missing** (and `slack_export_directory` is configured), do **not** ask
  and do not stop. Continue without Slack, and include this line in your end summary to
  the user: `No Slack summary for this week (slack-<START_DATE>.md); add one and re-run to
  include it.` Do not fabricate Slack content. (If the user asks how to produce one, the
  fill-in prompt is at `~/.claude/skills/status-report/reference/slack-summary-prompt.md`;
  do not offer it unprompted.)
```

- [ ] **Step 3: Insert the sessions step and renumber**

Rename `## 6. Synthesize the report` to `## 7. Synthesize the report`, and `## 7. Write the report and preview` to `## 8. Write the report and preview`. In the step 7 body, replace `Combine the `COMBINED_JSON` contents with the Linear, Calendar, and Slack material you gathered.` with `Combine the `COMBINED_JSON` contents with the Linear, Calendar, Slack, and session material you gathered.`

Insert this new section directly before `## 7. Synthesize the report`:

````markdown
## 6. Analyze agent sessions

`COMBINED_JSON.sessions.sessions[]` holds one entry per Claude Code / Codex session the user
typed into during the period (already filtered for automation, subagents and personal paths).
If `sessions` is absent, the collector failed. Say so in your end summary and continue.

1. **Match.** For each entry, look for a GitHub PR or local commit in the same `repo`
   (compare the repo name, e.g. `org/name`, to the PR's `repository`) whose branch is in the
   entry's `branches`, or whose timestamp falls between `first_prompt_at` and
   `last_prompt_at`. A matched session is **context only**: use it to explain why or what
   resulted, inside that PR's or commit's bullet. It never gets a bullet of its own.
2. **Group the unmatched entries** by `repo` (or by `cwd` when `repo` is null). Use `title`
   and `prompts` to merge sessions on the same topic into one piece of work.
3. **Deep read.** A group qualifies if its total `active_minutes` is at least 45 **or** its
   total `prompt_count` is at least 10, **and** its prompts plus `final_assistant_message`
   don't make clear what it concluded. Take at most **3** qualifying groups, largest total
   `active_minutes` first. For each, expand the group's session with the most
   `active_minutes`:

   ```bash
   ~/.claude/skills/status-report/scripts/sessions.py --expand <session_id> --start-date <START_DATE> --end-date <END_DATE>
   ```

   Read the transcript (typed prompts and assistant replies only). If it exits non-zero,
   note it and use the summary entry.
4. **Discard.** Drop unmatched sessions whose `cwd` is outside the repos directory (e.g. `~`
   or `~/Desktop`) unless their prompts are clearly about work for the client. Drop tooling
   and yak-shaving sessions (editor or agent setup, skill writing, dotfiles-style work),
   even inside a work repo, unless the result was for the team.
5. **Remember for the end summary:** which sessions you deep-read (title or repo) and how
   many you dropped in step 4.

Follow SESSION DATA HANDLING in `report-style.md` when writing these into the report.
````

- [ ] **Step 4: Extend the end summary**

In `## 8. Write the report and preview`, replace item `3. Tell the user the output path and show the first ~20 lines as a preview.` with:

```markdown
3. Tell the user the output path and show the first ~20 lines as a preview. Then list, briefly:
   - any source that was unavailable or failed (Linear, Calendar, sessions collector)
   - the missing-Slack line from step 5, if it applies
   - the sessions you deep-read and how many you dropped (step 6)
```

- [ ] **Step 5: Update report-style.md**

Replace the INPUT line:

```markdown
INPUT: collected data containing GitHub activity, local git commits, Linear issues, Google Calendar meetings, local documents, and Slack thread summaries. Any source may be absent.
```

with:

```markdown
INPUT: collected data containing GitHub activity, local git commits, Linear issues, Google Calendar meetings, local documents, Claude Code and Codex session digests, and Slack thread summaries. Any source may be absent.
```

Insert this section directly before `## OUTPUT REQUIREMENTS`:

```markdown
## SESSION DATA HANDLING
- `sessions[]` are the user's Claude Code and Codex sessions. `prompts` are what the user asked for; `final_assistant_message` is what the session concluded. Deep-read transcripts give fuller detail for a few sessions.
- Sessions matched to a PR or commit are context only: use them to explain why or what resulted, inside that item's bullet.
- Credit an unmatched session as work done only when it shows an outcome: an analysis finished, a root cause found, a design decided, a review delivered. Leave out exploratory or abandoned sessions, or describe them as in flight ("Began investigating…").
- Describe the work and its business value, never the tool. Do not write "used Claude" or "used Codex".
- Do not cite session IDs, paths or prompt text, and do not add a separate "Sessions" or "AI" section. Put session work into the existing sections.
- Prompts can contain secrets, customer or patient data, or colleagues' messages. Never quote them.
- When a Linear issue or document covers the same work, use that source's framing, and use the session only for what happened this week.
```

- [ ] **Step 6: Verify the edits**

Run:

```bash
grep -n '^## ' agents/skills/status-report/SKILL.md
grep -n 'ASK them\|Do not ask\|do \*\*not\*\* ask' agents/skills/status-report/SKILL.md
grep -n 'SESSION DATA HANDLING\|Claude Code and Codex' agents/skills/status-report/reference/report-style.md
```

Expected: headings numbered 1–8 in order, with `## 6. Analyze agent sessions`; no remaining "ASK them before generating" text; both report-style matches present.

- [ ] **Step 7: Commit**

```bash
git add agents/skills/status-report/SKILL.md agents/skills/status-report/reference/report-style.md
git commit -m "status-report: analyze agent sessions; make Slack optional

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Backfill: first week, then stop for review

Run this only after Tasks 1–8 are merged into the main `~/.dotfiles` checkout (the live
skill at `~/.claude/skills/status-report` reads it).

**Files:**
- Create: `~/Documents/status-report/reports/status-report-2026-07-27_to_2026-08-02.md`

**Interfaces:**
- Consumes: the whole skill.
- Produces: the first backfilled report. The remaining 8 weeks (2026-08-03 through 2026-09-21, each Mon–Sun) are generated only after the user approves this one.

- [ ] **Step 1: Generate the report**

Invoke the `status-report` skill for the explicit range `--start-date 2026-07-27 --end-date 2026-08-02` and follow SKILL.md end to end: collect.sh, Linear, Calendar, Slack (missing, so note it and continue), sessions analysis, synthesis, write.

- [ ] **Step 2: Sanity-check the output**

Run:

```bash
f=~/Documents/status-report/reports/status-report-2026-07-27_to_2026-08-02.md
head -5 "$f"
grep -niE 'claude|codex|session|/Users/|~/' "$f" || echo "no tool names or paths: OK"
```

Expected: the `**Period:** 2026-07-27 to 2026-08-02` header, and "no tool names or paths: OK".

- [ ] **Step 3: Stop and hand to the user**

Show the preview and end summary (sources, missing-Slack line, deep reads, dropped count). Ask the user to review the report before generating the remaining 8 weeks, oldest first. Do not continue without their approval.
