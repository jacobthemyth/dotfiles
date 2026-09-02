---
name: roundtripping-linear-issues
description: Use when exporting Linear issue child or grandchild titles and descriptions to editable Markdown, or applying edits from a marked Linear Markdown file back to tickets.
---

# Round-tripping Linear issues

Use the bundled CLI for the Linear → file → Linear workflow. It performs deterministic traversal, parsing, diffing, dry runs, safe argument handling, and post-write verification without spending model tokens on issue content.

## Prerequisites

`python3` and an authenticated `linear-cli` must be on `PATH`. Execute the script; do not read or reproduce its implementation unless maintaining it.

```bash
ROUNDTRIP="$HOME/.agents/skills/roundtripping-linear-issues/scripts/linear_issue_roundtrip.py"
```

## Workflow

### Export

```bash
python3 "$ROUNDTRIP" export NUR-2749 ./NUR-2749.md --json
```

This exports exactly the root issue's children and grandchildren. The file is flat: stable issue markers identify records, but parent relationships are not encoded. Existing output is preserved unless the user explicitly authorizes `--force`.

### Inspect edited content

```bash
python3 "$ROUNDTRIP" plan ./NUR-2749.md --json
```

Run `plan` before any mutation. Fix every validation or lookup error before continuing. The IDs in the file are the complete import scope; do not re-query hierarchy or add/remove records based on current parents.

### Apply

Only run this when the user's current request authorizes Linear writes:

```bash
python3 "$ROUNDTRIP" apply ./NUR-2749.md --json
```

`apply` updates only changed titles and descriptions. It dry-runs every planned update, re-fetches changed tickets to catch concurrent edits before the first write, then re-fetches all listed tickets without cache and verifies the result. Report any failure or mismatch by issue ID; do not broaden scope or retry every ticket blindly.

## Quick reference

| Need | Command |
|---|---|
| Export two levels | `export ROOT FILE --json` |
| Preview changes | `plan FILE --json` |
| Apply and verify | `apply FILE --json` |
| Replace an existing export | `export ROOT FILE --force --json` after explicit authorization |
| Limit export/apply concurrency | add `--jobs N` to `export` or `apply` (`1`–`16`, default `4`) |

## File contract

Edit text only under `## Title` and `## Description`. Keep every `LINEAR-ISSUE` marker and `# ISSUE-ID` heading unchanged. The strings `<!-- LINEAR-ISSUE:` and `<!-- /LINEAR-ISSUE -->` are reserved and cannot appear in issue content. Empty descriptions are valid and clear Linear descriptions. Linear canonicalizes unordered-list markers to `*`; the CLI treats `-`, `+`, and `*` as equivalent for recognized Markdown lists, including lists in blockquotes, but preserves them in fenced and indented code.

## Common mistakes

- Do not hand-parse the Markdown or interpolate content into shell commands.
- Do not export deeper descendants; the contract is child plus grandchild.
- Do not put parent IDs or nesting into the file.
- Do not infer import scope from the current hierarchy.
- Do not claim success from update responses alone; `apply` must finish verification.
