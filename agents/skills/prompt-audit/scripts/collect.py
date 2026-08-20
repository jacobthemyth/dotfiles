"""Extract genuine user prompts from Claude Code transcripts, tagged with the
model that answered each. Excludes tool results, subagent/meta turns, hook and
system injections, slash-command scaffolding, and multi-agent transport noise
(which inflated a naive pass by ~29%)."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

import common

_SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
_DROP_PREFIXES = (
    "[SYSTEM NOTIFICATION", "[Request interrupted", "Caveat: The messages below",
    "<local-command-stdout>", "<user-prompt-submit-hook>", "<post-tool-use-hook>",
    "<user-memory-input>",
)
_NOISE = re.compile(r"^(<teammate-message|<bash-(input|stdout|stderr)|task-notification)", re.I)
# Anchored: a slash-command scaffold *opens* with the tag, so only a leading
# match is scaffolding. A genuine prompt that merely quotes the tag is kept.
_COMMAND_NAME = re.compile(r"^<command-name>[^<]+</command-name>")


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_genuine(event: dict) -> bool:
    if event.get("type") != "user":
        return False
    if event.get("isSidechain") or event.get("isMeta") or event.get("isCompactSummary"):
        return False
    msg = event.get("message") or {}
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, list) and not any(
        isinstance(b, dict) and b.get("type") in ("text", "image") for b in content
    ):
        return False
    return True


def _clean(text: str):
    t = text.strip()
    if not t or _NOISE.search(t) or _COMMAND_NAME.search(t):
        return None
    if t.startswith("<command-message>") or t.startswith("<command-args>"):
        return None
    t = _SYSTEM_REMINDER.sub("", t).strip()
    if not t or t.startswith(_DROP_PREFIXES):
        return None
    return t


def prompts_from_events(events: Iterable[dict]) -> list[dict]:
    prompts: list[dict] = []
    pending: dict = {}
    for ev in events:
        session = ev.get("sessionId")
        if ev.get("type") == "assistant":
            model = (ev.get("message") or {}).get("model")
            if model and pending.get(session):
                for p in pending[session]:
                    p["model"] = model
                pending[session] = []
            continue
        if not _is_genuine(ev):
            continue
        text = _clean(_text_of((ev.get("message") or {}).get("content")))
        if text is None:
            continue
        cwd = ev.get("cwd") or ""
        rec = {"text": text, "project": Path(cwd).name if cwd else "",
               "session": session, "timestamp": ev.get("timestamp"), "model": None}
        prompts.append(rec)
        pending.setdefault(session, []).append(rec)
    return prompts


def collect_from(events: Iterable[dict], since: str | None = None) -> list[dict]:
    prompts = prompts_from_events(events)
    if since:
        prompts = [p for p in prompts if (p.get("timestamp") or "") > since]
    return prompts


def collect(root: Path | None = None, since: str | None = None) -> list[dict]:
    return collect_from(common.iter_events(root or common.projects_root()), since=since)
