"""Deterministic, $0 checks over prompt text. The logic is built in; the
parameters (word budget, banned words, which checks to enable) come from
deterministic criteria files. Stdlib only."""
from __future__ import annotations

import re


def check_max_words(text, params):
    limit = params.get("max_words")
    if not isinstance(limit, int):
        return None
    n = len(text.split())
    return f"{n} words > {limit}" if n > limit else None


def check_banned_words(text, params):
    words = params.get("banned_words") or []
    low = text.lower()
    hits = [w for w in words if re.search(r"\b" + re.escape(str(w).lower()) + r"\b", low)]
    return "banned: " + ", ".join(hits) if hits else None


_LATE = re.compile(r"\binstead of\b", re.I)
def check_late_constraint(text, params):
    return "late constraint ('instead of')" if _LATE.search(text) else None


_PREMISE = re.compile(r"^\s*i thought\b", re.I)
def check_faulty_premise(text, params):
    return "unverified premise ('I thought')" if _PREMISE.search(text) else None


_VAGUE = re.compile(r"\b(the thing|that thing|do that|fix (?:it|that|this)|like i said|as before)\b", re.I)
def check_ambiguous_referent(text, params):
    m = _VAGUE.search(text)
    return f"ambiguous referent ('{m.group(0)}')" if m else None


CHECKS = {
    "max_words": check_max_words,
    "banned_words": check_banned_words,
    "late_constraint": check_late_constraint,
    "faulty_premise": check_faulty_premise,
    "ambiguous_referent": check_ambiguous_referent,
}

DEFAULT_ENABLED = ["late_constraint", "faulty_premise", "ambiguous_referent"]


def merge_params(det_files):
    params: dict = {}
    enabled = set(DEFAULT_ENABLED)
    for f in det_files:
        for key in ("max_words", "banned_words"):
            if key in f.meta:
                params[key] = f.meta[key]
                enabled.add(key)
        for name in (f.meta.get("enable") or []):
            enabled.add(name)
    return params, enabled


def apply_to_prompt(text, params, enabled):
    findings = []
    for name in enabled:
        fn = CHECKS.get(name)
        if not fn:
            continue
        ev = fn(text, params)
        if ev:
            findings.append({"check": name, "evidence": ev})
    return findings
