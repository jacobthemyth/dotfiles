"""The single bounded paid pass: send a capped set of prompts to `claude -p`
for judgment against the applicable judgment rubric. One call per run. Stdlib
only. Fail-open: any failure returns an empty result, never raises."""
from __future__ import annotations

import json
import subprocess

JUDGE_MODEL = "claude-haiku-4-5"


def select_items(prompts, clusters, rule_findings, cap=20):
    order, seen = [], set()
    for c in sorted(clusters, key=lambda c: -c["size"]):
        idx = c["representative"]
        if idx not in seen:
            seen.add(idx)
            order.append(idx)
    worst = sorted(range(len(prompts)), key=lambda i: -len(rule_findings.get(i, [])))
    for i in worst:
        if rule_findings.get(i) and i not in seen:
            seen.add(i)
            order.append(i)
    return order[:cap]


def build_prompt(indices, prompts, judgment_by_model):
    lines = [
        "You are auditing a user's prompts to an AI coding agent.",
        "Judge each prompt against the applicable guidance below.",
        "Return ONLY a JSON array; one object per prompt with keys:",
        'index (int), violations (array of short strings), rewrite (improved prompt string).',
        "",
    ]
    for m in sorted({prompts[i].get("model") for i in indices} - {None}):
        bodies = [f.body for f in judgment_by_model.get(m, [])]
        if bodies:
            lines.append(f"## Guidance for {m}")
            lines.extend(bodies)
            lines.append("")
    lines.append("## Prompts")
    for i in indices:
        p = prompts[i]
        lines.append(f"### index {i} (model: {p.get('model')})")
        lines.append(p["text"])
        lines.append("")
    return "\n".join(lines)


def run_claude(prompt_text, model=JUDGE_MODEL):
    try:
        proc = subprocess.run(
            ["claude", "-p", "--model", model, "--output-format", "json"],
            input=prompt_text, capture_output=True, text=True, check=True,
            timeout=120,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    return proc.stdout


def parse_result(stdout):
    if not stdout:
        return None
    try:
        outer = json.loads(stdout)
        text = outer.get("result") if isinstance(outer, dict) else stdout
    except json.JSONDecodeError:
        text = stdout
    if not isinstance(text, str):
        return None
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end < start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def judge(indices, prompts, judgment_by_model, model=JUDGE_MODEL):
    if not indices:
        return []
    result = parse_result(run_claude(build_prompt(indices, prompts, judgment_by_model), model=model))
    return result if result is not None else []
