"""Render the audit report and manage trend state (one JSON summary per run).
Stdlib only."""
from __future__ import annotations

import datetime as dt
from collections import Counter

import common


def summarize(prompts, rule_findings, clusters, cluster_method):
    counts = Counter()
    for findings in rule_findings.values():
        for f in findings:
            counts[f["check"]] += 1
    return {
        "prompts": len(prompts),
        "clusters": len(clusters),
        "cluster_method": cluster_method,
        "check_counts": dict(counts),
        "flagged": sum(1 for f in rule_findings.values() if f),
    }


def _trend_line(current, previous):
    if not previous:
        return "_First run — no prior baseline._"
    d = current["flagged"] - previous.get("flagged", 0)
    arrow = "→" if d == 0 else ("▲" if d > 0 else "▼")
    return f"Flagged prompts: {current['flagged']} ({arrow} {d:+d} vs previous run)"


def render(summary, clusters, prompts, judge_results, previous):
    L = ["# Prompt Audit", "",
         f"_Generated {dt.date.today().isoformat()} · {summary['prompts']} new prompts · "
         f"clustering: {summary['cluster_method']}_", "",
         "## Trend", _trend_line(summary, previous), "",
         "## Deterministic checks", ""]
    if summary["check_counts"]:
        L += ["| Check | Hits |", "|---|---:|"]
        L += [f"| {k} | {v} |" for k, v in sorted(summary["check_counts"].items(), key=lambda kv: -kv[1])]
    else:
        L.append("_No deterministic findings._")
    L += ["", "## Theme clusters (top 10)", ""]
    for c in sorted(clusters, key=lambda c: -c["size"])[:10]:
        rep = prompts[c["representative"]]["text"].replace("\n", " ")[:100]
        L.append(f"- **{c['size']}×** {rep}")
    L += ["", "## Judgment (sampled)", ""]
    if judge_results:
        for r in judge_results:
            if not isinstance(r, dict):
                continue
            i = r.get("index")
            if not isinstance(i, int) or i < 0 or i >= len(prompts):
                continue
            L.append(f"- _{prompts[i]['text'].replace(chr(10), ' ')[:100]}_")
            L += [f"  - ⚠ {v}" for v in r.get("violations", [])]
            if r.get("rewrite"):
                L.append(f"  - ✎ {r['rewrite']}")
    else:
        L.append("_Judgment pass skipped or empty._")
    return "\n".join(L) + "\n"


def write_report(md, when=None):
    when = when or dt.datetime.now()
    path = common.reports_dir() / f"prompt-audit-{when:%Y-%m-%d-%H%M%S}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(md, encoding="utf-8")
    return path


def save_run(summary, when=None):
    when = when or dt.datetime.now()
    path = common.runs_dir() / f"{when:%Y-%m-%d-%H%M%S}.json"
    common.write_json(path, summary)
    return path


def load_previous():
    runs = common.runs_dir()
    if not runs.is_dir():
        return None
    files = sorted(runs.glob("*.json"))
    return common.read_json(files[-1]) if files else None
