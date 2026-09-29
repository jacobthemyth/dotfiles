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
