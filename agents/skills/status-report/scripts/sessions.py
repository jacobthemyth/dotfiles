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
