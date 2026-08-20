---
name: prompt-audit
description: Audit your own Claude Code prompts on demand against the answering model's guidance and custom criteria. Use when asked to "audit my prompts", "review my prompting", or "run a prompt audit". Local-first and cheap — deterministic checks + local embeddings do the bulk; one small model call carries the nuance.
---

# prompt-audit

Audits the prompts *you* typed (across `~/.claude/projects/`) and writes a
Markdown report: deterministic-check counts, semantic theme clusters, and a
sampled set of prompts with suggested rewrites. Incremental — each run covers
only prompts since the last one.

## Prerequisites (one-time)

- **ollama + an embedding model** for the free semantic layer:
  `brew install ollama && ollama serve` then `ollama pull nomic-embed-text`.
  Without it the audit still runs, falling back to token-signature clustering.
- **`claude` CLI** on PATH for the judgment pass.

## Run

```bash
python3 ~/.claude/skills/prompt-audit/scripts/audit.py --since 7d
```

- `--since 7d` or an ISO timestamp; omit to resume from the stored watermark.
- `--no-embed` forces the stdlib fallback (skip ollama).
- `--dry-run` prints the report without the paid judgment call or writing state.
- `--cap N` bounds the judgment pass (default 20).

Reports and state go under `$XDG_STATE_HOME/prompt-audit/` (default
`~/.local/state/prompt-audit/`).

## Custom criteria

Drop Markdown files in `$XDG_CONFIG_HOME/prompt-audit/` (default
`~/.config/prompt-audit/`). Each file's frontmatter selects where it applies —
see `references/README.md` for the contract and `references/examples/` for a
starting point. Model prompting guides ship in `references/`.

## Cost

Embeddings and clustering are local ($0). One `claude -p --model
claude-haiku-4-5` call per run over at most `--cap` prompts — a few cents,
independent of how much you wrote.
