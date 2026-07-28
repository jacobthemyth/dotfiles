# Local Documents Collector — Design Spec

**Status:** Draft
**Date:** 2026-05-26
**Owner:** <work-email>

## Goal

Add a fifth data source to the status report generator: local markdown and PDF documents that the user authored or edited during the report period. Documents are treated like any other collector's output — raw, bounded context the main LLM call uses to enrich the report — not a separate section of the final report.

The `document_directories` field already exists in `config.json` (marked "future use"). This spec implements the collector that field was reserved for.

## Non-goals

- Per-document LLM summarization (the raw content fits the context window).
- A dedicated "Documents" section in the final report.
- Following symlinks, parsing `.docx` / `.pages` / `.key`, or extracting text from images.
- Configurable globs or depth caps. Substring excludes + mtime are sufficient based on the May 2026 survey (320KB total across 26 files); add complexity only if it proves insufficient.

## Architecture

A new standalone collector `collectors/documents.py` that follows the existing pattern: takes `--start-date`, `--end-date`, writes JSON to `--output`. Wired into `generate.sh` as a fifth collector alongside github, git, linear, slack. No new shared libraries.

```
status-report/
├── generate.sh                  # orchestrator — adds documents block
├── config.json                  # schema additions (see §9)
├── collectors/
│   ├── github.py
│   ├── git-repos.sh
│   ├── linear.sh
│   ├── slack.py
│   └── documents.py             # NEW
└── lib/common.sh
```

## CLI

```
collectors/documents.py
  --start-date YYYY-MM-DD          required
  --end-date YYYY-MM-DD            required
  --directories DIR[,DIR,...]      required, comma-separated, ~ expanded
  --extensions md,pdf              optional, default "md,pdf"
  --exclude-patterns A,B,C         optional, substring match against full absolute path
  --max-file-bytes N               optional, default 20000
  --output FILE                    required
```

Exits 0 on success (including zero-documents). Exits non-zero only on fatal errors (e.g., output path unwritable).

## Discovery & filtering

For each configured directory, recursively walk and include a file iff **all** of the following hold:

1. File extension (lowercased, without dot) is in the allowed extensions list.
2. `mtime` is within `[start_date 00:00:00, end_date 23:59:59]` in local time.
3. The path does not contain any segment beginning with `.` (e.g., `.git`, `.venv`, `.claude`).
4. The path does not contain a segment named `node_modules`.
5. The path does not contain any user-supplied `exclude_patterns` substring (case-sensitive, simple substring match against the absolute path).
6. The file is not a symlink.

Walk uses `os.walk(followlinks=False)`. Hidden-segment and `node_modules` skipping is implemented by pruning `dirnames` in-place during the walk to avoid descending wasted trees.

## Auto-excluded paths

`generate.sh` resolves three additional substring exclusions from the user's own configuration and passes them via `--exclude-patterns` so the report never ingests its own outputs or already-collected sources:

- `output_directory` (absolute, `~` expanded) — the generated reports themselves.
- `slack_export_directory` (absolute, `~` expanded) — already pulled in by the Slack collector.
- `$SCRIPT_DIR` — the status-report tool's own root, so it never ingests itself (README.md, this spec, etc.).

These are merged with any user-supplied `document_exclude_patterns` from `config.json`.

## Content handling

**Markdown (.md):** Read as UTF-8 with `errors="replace"`. If file size exceeds `max-file-bytes`, read only the first `max-file-bytes` bytes and set `truncated: true`.

**PDF (.pdf):** Shell out to `pdftotext -layout -nopgbrk <path> -` and capture stdout. Apply the same byte-cap truncation to the resulting text.

- If `pdftotext` is not on `PATH`: log a single warning per run, mark `pdftotext_available: false` in output, and add every PDF that would have been collected to `skipped[]` with reason `"pdftotext not installed"`. The collector still succeeds.
- If `pdftotext` returns non-zero for a specific file: log a warning, add that file to `skipped[]` with reason `"pdftotext failed: <stderr-snippet>"`, continue.

## Output JSON shape

```json
{
  "date_range": { "start": "2026-05-01", "end": "2026-05-31" },
  "directories_scanned": [
    "/Users/jake/Desktop",
    "/Users/jake/Documents",
    "/Users/jake/Downloads"
  ],
  "extensions": ["md", "pdf"],
  "exclude_patterns_applied": [
    "/Users/jake/Documents/status-report/reports",
    "/Users/jake/Documents/slack_summaries",
    "/Users/jake/Documents/status-report"
  ],
  "pdftotext_available": true,
  "max_file_bytes": 20000,
  "documents": [
    {
      "path": "/Users/jake/Desktop/magical-seeking-wand.md",
      "name": "magical-seeking-wand.md",
      "extension": "md",
      "mtime": "2026-05-14T09:32:11",
      "size_bytes": 19283,
      "truncated": false,
      "content": "..."
    }
  ],
  "skipped": [
    { "path": "/Users/jake/Downloads/big.pdf", "reason": "pdftotext not installed" }
  ]
}
```

`documents[]` is sorted by `mtime` descending. `skipped[]` may be empty.

## generate.sh integration

1. Change the default `COLLECTORS` from `"github,git,linear"` to `"github,git,linear,documents"`. Update the usage text accordingly.

2. Add a new collector block after the Linear block and before the Slack block, structured like the existing blocks:

   ```bash
   if [[ "$COLLECTORS" == *"documents"* ]]; then
       log_info "Running documents collector..."

       DOC_DIRS_JSON=$(get_config_array "document_directories")
       if [[ -z "$DOC_DIRS_JSON" ]] || [[ "$DOC_DIRS_JSON" == "[]" ]]; then
           log_info "document_directories not configured, skipping"
       else
           # Build comma-separated, ~-expanded directory list
           DOC_DIRS=$(echo "$DOC_DIRS_JSON" | jq -r '.[]' | while read -r d; do expand_path "$d"; done | paste -sd, -)

           # Auto-excludes: own outputs, slack source, tool root, plus user list
           SLACK_DIR=$(get_config "slack_export_directory" "")
           OUTPUT_DIR_ABS=$(expand_path "$(get_config "output_directory" "$HOME/Desktop")")
           USER_EXCLUDES=$(get_config_array "document_exclude_patterns" "[]" | jq -r '. | join(",")')

           AUTO_EXCLUDES="$OUTPUT_DIR_ABS,$SCRIPT_DIR"
           [[ -n "$SLACK_DIR" && "$SLACK_DIR" != "null" ]] && AUTO_EXCLUDES="$AUTO_EXCLUDES,$(expand_path "$SLACK_DIR")"
           [[ -n "$USER_EXCLUDES" ]] && AUTO_EXCLUDES="$AUTO_EXCLUDES,$USER_EXCLUDES"

           DOC_EXTS=$(get_config_array "document_extensions" '["md","pdf"]' | jq -r '. | join(",")')
           DOC_MAX_BYTES=$(get_config "document_max_file_bytes" "20000")

           if "$SCRIPT_DIR/collectors/documents.py" \
               --start-date "$START_DATE" \
               --end-date "$END_DATE" \
               --directories "$DOC_DIRS" \
               --extensions "$DOC_EXTS" \
               --exclude-patterns "$AUTO_EXCLUDES" \
               --max-file-bytes "$DOC_MAX_BYTES" \
               --output "$TEMP_DIR/documents.json"; then
               log_success "Documents collected"
               SUCCESSFUL_COLLECTORS+=("documents")
           else
               log_warn "Documents collector failed"
           fi
       fi
   fi
   ```

3. Add a documents merge block to the "Combine all JSON files" section, matching the existing `jq --slurpfile` pattern, merging under `.documents`.

4. If `get_config_array` does not already exist in `lib/common.sh`, add it. It should return the raw JSON array string for a key, defaulting to the given fallback.

## LLM prompt addition

Append a block to the existing `SYSTEM_PROMPT` heredoc in `generate.sh`, in the same style as the existing `SLACK DATA HANDLING` block, placed immediately before `OUTPUT REQUIREMENTS`:

```
DOCUMENT DATA HANDLING:
- documents[] are markdown/PDF files the user authored or edited in this period
- Use them as context to enrich existing sections (Development, Operations, Infrastructure, Collaboration)
- A design doc, spec, or RFC indicates substantive work in Development or Infrastructure
- Meeting notes or status drafts indicate Collaboration
- Filenames and paths are private context — do NOT cite paths in the report
- Do NOT add a separate "Documents" or "Writing" section to the report
- If `truncated: true`, treat absent content as unknown rather than significant
- Documents with no clear connection to work activity should be ignored
```

## Config schema additions

`config.json` gains three optional fields and starts actually using `document_directories`. README's config table is updated to match.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `document_directories` | `string[]` | (none) | Directories to recursively scan for documents. Required for the documents collector to run. |
| `document_exclude_patterns` | `string[]` | `[]` | Substrings that, if found in a file's absolute path, exclude it. |
| `document_extensions` | `string[]` | `["md","pdf"]` | File extensions (without dot) to include. |
| `document_max_file_bytes` | `number` | `20000` | Per-file byte cap; longer files are truncated. |

## Error handling

| Situation | Behavior |
|-----------|----------|
| `document_directories` unset or empty | `generate.sh` logs info, skips the collector cleanly, exit 0. |
| A directory in `document_directories` doesn't exist | Collector logs warning, skips that directory, continues. |
| File read fails (permission, decode error past replace, etc.) | Collector logs warning, skips that file, continues. |
| `pdftotext` not on PATH | One-time warning; all matching PDFs go to `skipped[]`; collector still succeeds. |
| `pdftotext` fails on a specific file | Warning; that file goes to `skipped[]`; collector continues. |
| Zero documents matched | Collector writes valid JSON with empty `documents[]`; treated as success. |

The collector never aborts the broader `generate.sh` run.

## Testing

Manually verifiable, matching the rest of the project (no automated test suite exists). Each is a smoke test, not an assertion:

- Run with `--collectors documents --month 2026-05` and confirm `documents[]` length matches `find ... -newermt 2026-05-01 ! -newermt 2026-06-01` (the inclusive-end equivalent of the spec's `[start 00:00, end 23:59:59]` window) minus auto-excluded paths.
- Confirm `status-report-2026-04.md`, `slack-2026-04.md`, and `README.md` from this repo do **not** appear in `documents[]`.
- Temporarily rename `pdftotext`; confirm `pdftotext_available: false` and that PDFs appear in `skipped[]`.
- Run for a future month and confirm valid empty output, no errors.
- Run a full report end-to-end and inspect the rendered markdown: confirm document context shows up woven into existing sections, and there is no "Documents" header.

## Implementation order

1. Add `get_config_array` to `lib/common.sh` if missing.
2. Write `collectors/documents.py` (mirror the structure of `collectors/slack.py` and `collectors/github.py`).
3. Wire the new block and JSON merge into `generate.sh`; flip the default `COLLECTORS` value.
4. Add the `DOCUMENT DATA HANDLING` block to the `SYSTEM_PROMPT` heredoc.
5. Update `README.md`'s config table and Data Collectors section.
6. Run end-to-end for May 2026, verify the smoke tests above.
