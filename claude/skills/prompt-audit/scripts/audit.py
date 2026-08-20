"""prompt-audit orchestrator: collect -> rules -> cluster -> judge -> report.
Incremental via a watermark; fail-open at every stage. Stdlib only.

Run: python3 audit.py [--since 7d|<ISO>] [--no-embed] [--cap N] [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import cluster as cluster_mod  # noqa: E402
import collect  # noqa: E402
import common  # noqa: E402
import judge as judge_mod  # noqa: E402
import report as report_mod  # noqa: E402
import rubric  # noqa: E402
import rules as rules_mod  # noqa: E402

REFERENCES = HERE.parent / "references"


def _since_from_arg(arg, watermark_last):
    if arg is None:
        return watermark_last
    if arg.endswith("d") and arg[:-1].isdigit():
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(arg[:-1]))
        # Transcript timestamps are Z-suffixed; isoformat() would yield a
        # +00:00 offset that mis-orders against them under a string compare.
        return cutoff.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return arg


def run(argv=None):
    ap = argparse.ArgumentParser(prog="prompt-audit")
    ap.add_argument("--since")
    ap.add_argument("--no-embed", action="store_true")
    ap.add_argument("--cap", type=int, default=20)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    wm = common.read_json(common.watermark_path(), {}) or {}
    since = _since_from_arg(args.since, wm.get("last"))
    prompts = collect.collect(since=since)
    if not prompts:
        print("prompt-audit: no new prompts since", since or "(beginning)")
        return 0

    files = rubric.load_all(REFERENCES)
    rule_findings = {}
    for i, p in enumerate(prompts):
        det = rubric.resolve_for_model(p.get("model"), files)["deterministic"]
        params, enabled = rules_mod.merge_params(det)
        rule_findings[i] = rules_mod.apply_to_prompt(p["text"], params, enabled)

    clusters, method = cluster_mod.cluster(
        [p["text"] for p in prompts], use_embeddings=not args.no_embed)

    judgment_by_model = {}
    for p in prompts:
        m = p.get("model")
        if m and m not in judgment_by_model:
            judgment_by_model[m] = rubric.resolve_for_model(m, files)["judgment"]

    indices = judge_mod.select_items(prompts, clusters, rule_findings, cap=args.cap)
    judge_results = [] if args.dry_run else judge_mod.judge(indices, prompts, judgment_by_model)

    summary = report_mod.summarize(prompts, rule_findings, clusters, method)
    md = report_mod.render(summary, clusters, prompts, judge_results, report_mod.load_previous())

    if args.dry_run:
        print(md)
        return 0

    path = report_mod.write_report(md)
    report_mod.save_run(summary)
    newest = max((p.get("timestamp") or "") for p in prompts)
    common.write_json(common.watermark_path(), {"last": newest})
    print("prompt-audit: wrote", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
