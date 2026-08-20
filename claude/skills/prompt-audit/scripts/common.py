"""Shared helpers for prompt-audit: XDG paths, transcript iteration, a tiny
frontmatter parser, and JSON I/O. Stdlib only, so the skill needs no install."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterator


def _xdg(env: str, default: Path) -> Path:
    v = os.environ.get(env)
    return Path(v).expanduser() if v else default


def xdg_config_home() -> Path:
    return _xdg("XDG_CONFIG_HOME", Path.home() / ".config")


def xdg_state_home() -> Path:
    return _xdg("XDG_STATE_HOME", Path.home() / ".local" / "state")


def criteria_dir() -> Path:
    return xdg_config_home() / "prompt-audit"


def state_dir() -> Path:
    return xdg_state_home() / "prompt-audit"


def reports_dir() -> Path:
    return state_dir() / "reports"


def runs_dir() -> Path:
    return state_dir() / "runs"


def watermark_path() -> Path:
    return state_dir() / "watermark.json"


def projects_root() -> Path:
    return Path.home() / ".claude" / "projects"


def iter_events(root: Path) -> Iterator[dict]:
    for path in sorted(root.rglob("*.jsonl")):
        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def _unquote(s: str) -> str:
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def _split_top_level(inner: str) -> list[str]:
    """Split on commas that are not inside a quoted run, so a quoted list item
    containing a comma stays one item."""
    items: list[str] = []
    buf: list[str] = []
    quote = ""
    for ch in inner:
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch == ",":
            items.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    items.append("".join(buf))
    return items


def _parse_scalar(val: str):
    if val.startswith("[") and val.endswith("]"):
        inner = val[1:-1].strip()
        return [] if not inner else [_unquote(x.strip()) for x in _split_top_level(inner)]
    return _unquote(val)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse a leading '---' block. Supports 'key: scalar' and 'key: [a, b]'."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, text
    meta: dict = {}
    for raw in lines[1:end]:
        if not raw.strip() or raw.strip().startswith("#") or ":" not in raw:
            continue
        key, _, val = raw.partition(":")
        meta[key.strip()] = _parse_scalar(val.strip())
    return meta, "\n".join(lines[end + 1:]).lstrip("\n")


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return default


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1), encoding="utf-8")
