# Local Documents Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth collector to the status-report generator that ingests local markdown and PDF files modified during the report period, with content woven into existing report sections by the main LLM call.

**Architecture:** A standalone Python collector (`collectors/documents.py`) that walks the configured `document_directories`, filters by extension + mtime + exclusion rules, reads `.md` directly and `.pdf` via `pdftotext`, applies a per-file byte cap, and emits JSON in the same shape as the other collectors. `generate.sh` resolves auto-excludes (the report's own output dir, the Slack source dir, and the tool root) from the user's own config and passes them via `--exclude-patterns`. A new `DOCUMENT DATA HANDLING` block is appended to the main `SYSTEM_PROMPT`.

**Tech Stack:** Python 3.8+ stdlib (no new pip deps), bash 4+, `jq`, `pdftotext` (soft dependency from poppler).

**Spec:** `docs/superpowers/specs/2026-05-26-local-documents-design.md`

**Note:** This project is not under git, so no commit steps appear in this plan. Each task ends with a smoke-test verification step that the implementer must run before moving on.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `collectors/documents.py` | Create | Walk dirs, filter, read content, emit JSON. ~200 lines. |
| `lib/common.sh` | Modify | Add `get_config_array` helper; have `load_config` remember the config file path. |
| `generate.sh` | Modify | New collector block, JSON merge into combined, default-collector list, prompt addition. |
| `README.md` | Modify | New config fields in the table; documents collector section. |
| `config.json` | Unchanged | Existing `document_directories` is reused; new fields are optional. |

---

## Task 1: Add config helpers to `lib/common.sh`

**Why:** The existing `load_config` exports config values as env vars and `get_config` reads those. The current array-export path in `load_config` produces broken shell quoting (`"["a","b"]"` after eval). Rather than fix it, add a new helper that re-reads array values directly from the config file via `jq`. Also persist the config file path so the helper knows which file to read.

**Files:**
- Modify: `lib/common.sh:42-71` (load_config) and append new function near `get_config`.

- [ ] **Step 1: Have `load_config` remember the config file path**

Edit `lib/common.sh` `load_config()` to store the resolved config path in a global. Replace the function body (lines 42-71) with the version below — the only change vs. current is the new `_CONFIG_FILE_PATH="$config_file"` line before the `eval`:

```bash
# Load configuration from JSON file
load_config() {
    local config_file="${1:-$DEFAULT_CONFIG}"

    if [[ ! -f "$config_file" ]]; then
        log_error "Configuration file not found: $config_file"
        return 1
    fi

    if ! command_exists jq; then
        log_error "jq is required but not installed"
        return 1
    fi

    # Remember the resolved config path so helpers like get_config_array can re-read it
    _CONFIG_FILE_PATH="$config_file"

    # Export config values as environment variables
    eval "$(jq -r '
        to_entries |
        map(
            if .value == null then
                ""
            elif .value | type == "array" then
                "export CONFIG_" + (.key | ascii_upcase) + "=\"" + (.value | @json) + "\""
            else
                "export CONFIG_" + (.key | ascii_upcase) + "=\"" + (.value | tostring) + "\""
            end
        ) |
        .[]
    ' "$config_file")"

    return 0
}
```

- [ ] **Step 2: Add `get_config_array` helper**

Append this function to `lib/common.sh` immediately after `get_config()` (after line 81):

```bash
# Get an array config value as a JSON string (e.g., '["a","b"]')
# Bypasses the env-var export path because bash doesn't quote arrays cleanly.
get_config_array() {
    local key="$1"
    local default="${2:-[]}"
    local config_file="${_CONFIG_FILE_PATH:-$DEFAULT_CONFIG}"

    if [[ ! -f "$config_file" ]]; then
        echo "$default"
        return 0
    fi

    local value
    value=$(jq -c --arg key "$key" '
        if has($key) and (.[$key] | type) == "array" then .[$key]
        else empty
        end
    ' "$config_file" 2>/dev/null)

    if [[ -z "$value" || "$value" == "null" ]]; then
        echo "$default"
    else
        echo "$value"
    fi
}
```

- [ ] **Step 3: Smoke-test the helper from the shell**

Run:

```bash
cd /Users/jake/Documents/status-report
bash -c '
source lib/common.sh
load_config ./config.json >/dev/null
echo "document_directories: $(get_config_array document_directories)"
echo "missing_key: $(get_config_array some_missing_key)"
echo "missing_with_default: $(get_config_array some_missing_key "[\"x\",\"y\"]")"
'
```

Expected output:

```
document_directories: ["~/Desktop","~/Documents","~/Downloads"]
missing_key: []
missing_with_default: ["x","y"]
```

If any line differs, fix the helper before moving on.

---

## Task 2: Create `collectors/documents.py` skeleton with CLI

**Why:** Establish the entry point, argument parsing, and JSON output shape before adding logic. Mirrors the pattern of `collectors/slack.py`.

**Files:**
- Create: `collectors/documents.py`

- [ ] **Step 1: Write the skeleton**

Create `collectors/documents.py` with this content (executable, will be expanded by later tasks):

```python
#!/usr/bin/env python3
"""
Local Documents Collector for Status Reports

Walks configured directories, finds markdown and PDF files modified in the
report period, applies exclusion rules, and emits the contents as JSON for
the main LLM prompt.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect local markdown/PDF documents for status reports"
    )
    parser.add_argument("--start-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--end-date", required=True, help="YYYY-MM-DD")
    parser.add_argument(
        "--directories",
        required=True,
        help="Comma-separated directories to scan (~ is expanded)",
    )
    parser.add_argument(
        "--extensions",
        default="md,pdf",
        help="Comma-separated extensions without dots (default: md,pdf)",
    )
    parser.add_argument(
        "--exclude-patterns",
        default="",
        help="Comma-separated substrings; any match against the absolute path excludes the file",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=20000,
        help="Per-file byte cap; longer files are truncated (default: 20000)",
    )
    parser.add_argument("--output", required=True, help="Output JSON file path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    directories = [
        os.path.expanduser(d.strip())
        for d in args.directories.split(",")
        if d.strip()
    ]
    extensions = {
        e.strip().lower().lstrip(".")
        for e in args.extensions.split(",")
        if e.strip()
    }
    exclude_patterns = [
        p.strip()
        for p in args.exclude_patterns.split(",")
        if p.strip()
    ]

    pdftotext_available = shutil.which("pdftotext") is not None
    if "pdf" in extensions and not pdftotext_available:
        print(
            "Warning: pdftotext not on PATH; PDFs will be skipped",
            file=sys.stderr,
        )

    output: Dict[str, Any] = {
        "date_range": {"start": args.start_date, "end": args.end_date},
        "directories_scanned": directories,
        "extensions": sorted(extensions),
        "exclude_patterns_applied": exclude_patterns,
        "pdftotext_available": pdftotext_available,
        "max_file_bytes": args.max_file_bytes,
        "documents": [],
        "skipped": [],
    }

    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(
        f"Documents collected: 0 (skeleton)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Users/jake/Documents/status-report/collectors/documents.py
```

- [ ] **Step 3: Smoke-test the skeleton**

```bash
cd /Users/jake/Documents/status-report
./collectors/documents.py \
  --start-date 2026-05-01 \
  --end-date 2026-05-31 \
  --directories ~/Desktop,~/Documents \
  --output /tmp/documents-skeleton.json
cat /tmp/documents-skeleton.json
```

Expected: a JSON object with `date_range`, `directories_scanned` (showing the expanded absolute paths), `extensions: ["md","pdf"]`, `pdftotext_available: true` (or false on a host without poppler), `documents: []`, `skipped: []`. No traceback.

---

## Task 3: Implement file discovery (walk + extension + mtime)

**Why:** The core matching loop. Filters by extension and mtime only — exclusions come next.

**Files:**
- Modify: `collectors/documents.py` (add `find_candidates`, call from `main`)

- [ ] **Step 1: Add date-window helper**

Insert this helper function above `main` in `collectors/documents.py`:

```python
def date_window(start_date: str, end_date: str) -> tuple:
    """Return (start_ts, end_ts) inclusive of the end date through 23:59:59 local."""
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d").replace(
        hour=23, minute=59, second=59
    )
    return start_dt.timestamp(), end_dt.timestamp()
```

- [ ] **Step 2: Add the directory walker**

Insert this function above `main`:

```python
def find_candidates(
    directories: List[str],
    extensions: set,
    start_ts: float,
    end_ts: float,
) -> List[Path]:
    """Walk directories and return paths matching extension + mtime."""
    candidates: List[Path] = []
    for d in directories:
        root = Path(d)
        if not root.is_dir():
            print(f"Warning: directory not found: {d}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            for name in filenames:
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext not in extensions:
                    continue
                p = Path(dirpath) / name
                try:
                    if p.is_symlink():
                        continue
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                if not (start_ts <= mtime <= end_ts):
                    continue
                candidates.append(p)
    return candidates
```

- [ ] **Step 3: Wire it into `main` and print the count**

Replace the body of `main()` (everything after `pdftotext_available = ...` through the end of the `output` dict but before the `with open` line) so it calls `find_candidates`. The full `main` should now read:

```python
def main() -> int:
    args = parse_args()

    directories = [
        os.path.expanduser(d.strip())
        for d in args.directories.split(",")
        if d.strip()
    ]
    extensions = {
        e.strip().lower().lstrip(".")
        for e in args.extensions.split(",")
        if e.strip()
    }
    exclude_patterns = [
        p.strip()
        for p in args.exclude_patterns.split(",")
        if p.strip()
    ]

    pdftotext_available = shutil.which("pdftotext") is not None
    if "pdf" in extensions and not pdftotext_available:
        print(
            "Warning: pdftotext not on PATH; PDFs will be skipped",
            file=sys.stderr,
        )

    start_ts, end_ts = date_window(args.start_date, args.end_date)
    candidates = find_candidates(directories, extensions, start_ts, end_ts)

    output: Dict[str, Any] = {
        "date_range": {"start": args.start_date, "end": args.end_date},
        "directories_scanned": directories,
        "extensions": sorted(extensions),
        "exclude_patterns_applied": exclude_patterns,
        "pdftotext_available": pdftotext_available,
        "max_file_bytes": args.max_file_bytes,
        "documents": [{"path": str(p)} for p in candidates],
        "skipped": [],
    }

    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Candidates found: {len(candidates)}", file=sys.stderr)
    return 0
```

- [ ] **Step 4: Smoke-test against May 2026**

```bash
cd /Users/jake/Documents/status-report
./collectors/documents.py \
  --start-date 2026-05-01 \
  --end-date 2026-05-31 \
  --directories ~/Desktop,~/Documents,~/Downloads \
  --output /tmp/documents-walk.json

# Expected: 26 .md candidates + 1 .pdf in Downloads = 27 total (per the spec survey).
# Note: this still includes paths under ~/Documents/status-report/ — exclusions come in Task 4.
jq '.documents | length' /tmp/documents-walk.json
```

Expected: `27` (or close — file counts may drift if the user creates/touches files between when the survey ran and when this is run).

---

## Task 4: Add exclusion filters

**Why:** Skip hidden directories (`.git`, `.venv`), `node_modules`, and any user-supplied exclude-pattern substring. Without this, the collector ingests the report's own previous outputs and Slack source data.

**Files:**
- Modify: `collectors/documents.py` (extend `find_candidates`)

- [ ] **Step 1: Replace `find_candidates` with the version that prunes & filters**

Replace the entire `find_candidates` function with this version:

```python
def find_candidates(
    directories: List[str],
    extensions: set,
    start_ts: float,
    end_ts: float,
    exclude_patterns: List[str],
) -> List[Path]:
    """Walk directories and return paths matching all filters."""
    candidates: List[Path] = []
    for d in directories:
        root = Path(d)
        if not root.is_dir():
            print(f"Warning: directory not found: {d}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # Prune hidden segments and node_modules in-place so we don't descend
            dirnames[:] = [
                dn for dn in dirnames
                if not dn.startswith(".") and dn != "node_modules"
            ]
            # Prune subtrees that match an exclude pattern
            dirnames[:] = [
                dn for dn in dirnames
                if not _matches_exclude(os.path.join(dirpath, dn), exclude_patterns)
            ]

            for name in filenames:
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext not in extensions:
                    continue
                p = Path(dirpath) / name
                abspath = str(p.resolve(strict=False))
                if _matches_exclude(abspath, exclude_patterns):
                    continue
                if any(part.startswith(".") for part in p.parts):
                    continue
                try:
                    if p.is_symlink():
                        continue
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                if not (start_ts <= mtime <= end_ts):
                    continue
                candidates.append(p)
    return candidates


def _matches_exclude(path: str, patterns: List[str]) -> bool:
    """True if any pattern is a substring of path (case-sensitive)."""
    return any(p and p in path for p in patterns)
```

- [ ] **Step 2: Update the `find_candidates` call site**

In `main()`, change the call from:

```python
candidates = find_candidates(directories, extensions, start_ts, end_ts)
```

to:

```python
candidates = find_candidates(
    directories, extensions, start_ts, end_ts, exclude_patterns
)
```

- [ ] **Step 3: Smoke-test exclusions**

```bash
cd /Users/jake/Documents/status-report
./collectors/documents.py \
  --start-date 2026-05-01 \
  --end-date 2026-05-31 \
  --directories ~/Desktop,~/Documents,~/Downloads \
  --exclude-patterns "/Users/jake/Documents/status-report,/Users/jake/Documents/slack_summaries" \
  --output /tmp/documents-excluded.json

# Confirm none of the excluded paths show up
jq -r '.documents[].path' /tmp/documents-excluded.json | grep -E "status-report|slack_summaries" || echo "OK: no excluded paths in output"
jq '.documents | length' /tmp/documents-excluded.json
```

Expected: prints `OK: no excluded paths in output`, and the count drops below Task 3's number (the spec survey showed at least 3 files under `status-report/` in May 2026).

---

## Task 5: Implement markdown content reading + truncation

**Why:** Each candidate needs `name`, `extension`, `mtime`, `size_bytes`, `truncated`, `content`. For `.md` we read directly with UTF-8 + replacement.

**Files:**
- Modify: `collectors/documents.py` (add `read_markdown`, change `main` to populate full document objects)

- [ ] **Step 1: Add `read_markdown` helper**

Insert above `main`:

```python
def read_markdown(path: Path, max_bytes: int) -> Dict[str, Any]:
    """Read a markdown file as UTF-8 with replacement, truncating at max_bytes."""
    size = path.stat().st_size
    truncated = size > max_bytes
    with open(path, "rb") as f:
        raw = f.read(max_bytes) if truncated else f.read()
    content = raw.decode("utf-8", errors="replace")
    return {"content": content, "truncated": truncated, "size_bytes": size}
```

- [ ] **Step 2: Add `build_document` helper**

Insert above `main`:

```python
def build_document(
    path: Path,
    max_bytes: int,
    pdftotext_available: bool,
    skipped: List[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """Return a document dict or None (with a `skipped` entry appended) on failure."""
    ext = path.suffix.lstrip(".").lower()
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
    except OSError as e:
        skipped.append({"path": str(path), "reason": f"stat failed: {e}"})
        return None

    if ext == "md":
        try:
            body = read_markdown(path, max_bytes)
        except OSError as e:
            skipped.append({"path": str(path), "reason": f"read failed: {e}"})
            return None
        return {
            "path": str(path),
            "name": path.name,
            "extension": ext,
            "mtime": mtime,
            "size_bytes": body["size_bytes"],
            "truncated": body["truncated"],
            "content": body["content"],
        }

    # PDF handling lands in Task 6. For now, route unknown extensions to skipped.
    skipped.append({"path": str(path), "reason": f"unsupported extension: {ext}"})
    return None
```

- [ ] **Step 3: Rewrite `main` to build full documents**

Replace the section of `main` that builds `output["documents"]` (the `output: Dict[str, Any] = {...}` block) with:

```python
    skipped: List[Dict[str, str]] = []
    documents: List[Dict[str, Any]] = []
    for path in candidates:
        doc = build_document(
            path, args.max_file_bytes, pdftotext_available, skipped
        )
        if doc is not None:
            documents.append(doc)

    documents.sort(key=lambda d: d["mtime"], reverse=True)

    output: Dict[str, Any] = {
        "date_range": {"start": args.start_date, "end": args.end_date},
        "directories_scanned": directories,
        "extensions": sorted(extensions),
        "exclude_patterns_applied": exclude_patterns,
        "pdftotext_available": pdftotext_available,
        "max_file_bytes": args.max_file_bytes,
        "documents": documents,
        "skipped": skipped,
    }
```

And change the final stderr line to:

```python
    print(
        f"Documents collected: {len(documents)}, skipped: {len(skipped)}",
        file=sys.stderr,
    )
```

- [ ] **Step 4: Smoke-test markdown collection**

```bash
cd /Users/jake/Documents/status-report
./collectors/documents.py \
  --start-date 2026-05-01 \
  --end-date 2026-05-31 \
  --directories ~/Desktop,~/Documents \
  --exclude-patterns "/Users/jake/Documents/status-report,/Users/jake/Documents/slack_summaries" \
  --extensions md \
  --max-file-bytes 20000 \
  --output /tmp/documents-md.json

# Verify shape of a sample document
jq '.documents[0] | {name, extension, mtime, size_bytes, truncated, content_preview: (.content[:120])}' /tmp/documents-md.json

# Verify truncation: count docs with truncated:true (should be >0 given the survey showed several files >20KB)
jq '[.documents[] | select(.truncated == true)] | length' /tmp/documents-md.json

# Verify mtime sort order is descending
jq -r '.documents[].mtime' /tmp/documents-md.json | sort -r -c && echo "OK: sorted descending"
```

Expected: doc object has all six fields populated; at least 3-4 truncated documents (the spec survey listed several .md files >20KB); the sort-c check prints `OK: sorted descending`.

---

## Task 6: Implement PDF content reading with graceful fallback

**Why:** PDFs in `document_directories` carry real signal (design docs, briefs). `pdftotext` is a soft dependency — if missing, all PDFs go to `skipped[]` but the collector still succeeds.

**Files:**
- Modify: `collectors/documents.py` (add `read_pdf`, extend `build_document`)

- [ ] **Step 1: Add `read_pdf` helper**

Insert above `build_document`:

```python
def read_pdf(path: Path, max_bytes: int) -> Dict[str, Any]:
    """Convert a PDF to text via pdftotext. Raises subprocess.CalledProcessError on failure."""
    size = path.stat().st_size
    result = subprocess.run(
        ["pdftotext", "-layout", "-nopgbrk", str(path), "-"],
        capture_output=True,
        check=True,
    )
    text = result.stdout.decode("utf-8", errors="replace")
    truncated = len(text.encode("utf-8")) > max_bytes
    if truncated:
        # Truncate by character count up to max_bytes, then re-encode
        encoded = text.encode("utf-8")[:max_bytes]
        text = encoded.decode("utf-8", errors="ignore")
    return {"content": text, "truncated": truncated, "size_bytes": size}
```

- [ ] **Step 2: Extend `build_document` to handle PDFs**

Replace the entire `build_document` function with this version (adds the `pdf` branch in place of the `unsupported extension` fallthrough):

```python
def build_document(
    path: Path,
    max_bytes: int,
    pdftotext_available: bool,
    skipped: List[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """Return a document dict or None (with a `skipped` entry appended) on failure."""
    ext = path.suffix.lstrip(".").lower()
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
    except OSError as e:
        skipped.append({"path": str(path), "reason": f"stat failed: {e}"})
        return None

    if ext == "md":
        try:
            body = read_markdown(path, max_bytes)
        except OSError as e:
            skipped.append({"path": str(path), "reason": f"read failed: {e}"})
            return None
    elif ext == "pdf":
        if not pdftotext_available:
            skipped.append({"path": str(path), "reason": "pdftotext not installed"})
            return None
        try:
            body = read_pdf(path, max_bytes)
        except subprocess.CalledProcessError as e:
            stderr_snippet = (e.stderr or b"").decode("utf-8", errors="replace")[:200].strip()
            skipped.append(
                {"path": str(path), "reason": f"pdftotext failed: {stderr_snippet}"}
            )
            return None
        except OSError as e:
            skipped.append({"path": str(path), "reason": f"read failed: {e}"})
            return None
    else:
        skipped.append({"path": str(path), "reason": f"unsupported extension: {ext}"})
        return None

    return {
        "path": str(path),
        "name": path.name,
        "extension": ext,
        "mtime": mtime,
        "size_bytes": body["size_bytes"],
        "truncated": body["truncated"],
        "content": body["content"],
    }
```

- [ ] **Step 3: Smoke-test PDF reading (happy path)**

```bash
cd /Users/jake/Documents/status-report
./collectors/documents.py \
  --start-date 2026-05-01 \
  --end-date 2026-05-31 \
  --directories ~/Downloads \
  --extensions pdf \
  --max-file-bytes 20000 \
  --output /tmp/documents-pdf.json

jq '.pdftotext_available, (.documents | length), (.documents[0] | {name, size_bytes, truncated, content_preview: (.content[:120])})' /tmp/documents-pdf.json
```

Expected (assuming `pdftotext` is installed and the survey-flagged PDF in Downloads is still there): `pdftotext_available: true`, at least 1 document, content_preview is real extracted text from the PDF.

- [ ] **Step 4: Smoke-test PDF graceful skip**

```bash
cd /Users/jake/Documents/status-report
# Run with pdftotext masked from PATH
PATH="/usr/bin:/bin" ./collectors/documents.py \
  --start-date 2026-05-01 \
  --end-date 2026-05-31 \
  --directories ~/Downloads \
  --extensions pdf \
  --output /tmp/documents-no-pdftotext.json 2>&1 | head -5

jq '{pdftotext_available, documents: (.documents | length), skipped_count: (.skipped | length), first_skipped: .skipped[0]}' /tmp/documents-no-pdftotext.json
```

Expected: stderr warned about missing pdftotext; `pdftotext_available: false`; `documents: 0`; `skipped_count >= 1`; `first_skipped.reason` says `pdftotext not installed`. Exit code 0 (run `echo $?` to confirm).

> Note: this assumes `pdftotext` lives outside `/usr/bin:/bin` (likely `/opt/homebrew/bin` or `/usr/local/bin`). If `which pdftotext` shows it inside the masked PATH, adjust the PATH to genuinely exclude it.

---

## Task 7: Wire the collector into `generate.sh`

**Why:** Resolve the user's auto-excludes, invoke the collector, merge its JSON, flip the default `COLLECTORS` value.

**Files:**
- Modify: `generate.sh` (default value at line 22, new collector block after the Linear block ~line 232, JSON merge in the combine section ~line 311, usage text at lines 41-43)

- [ ] **Step 1: Flip the default `COLLECTORS`**

Edit `generate.sh:22` from:

```bash
COLLECTORS="github,git,linear"
```

to:

```bash
COLLECTORS="github,git,linear,documents"
```

- [ ] **Step 2: Update the usage text**

Edit the `--collectors` description in the usage heredoc (around `generate.sh:41-43`) from:

```
  --collectors LIST         Comma-separated list of collectors to run
                            Available: github, git, linear, slack
                            Default: github,git,linear
```

to:

```
  --collectors LIST         Comma-separated list of collectors to run
                            Available: github, git, linear, slack, documents
                            Default: github,git,linear,documents
```

- [ ] **Step 3: Add the new collector block**

Insert this block in `generate.sh` *after* the Linear block (which ends around line 232) and *before* the Slack block (which begins around `if [[ "$COLLECTORS" == *"slack"* ]]; then`):

```bash
# Run documents collector
if [[ "$COLLECTORS" == *"documents"* ]]; then
    log_info "Running documents collector..."

    DOC_DIRS_JSON=$(get_config_array "document_directories")
    if [[ "$DOC_DIRS_JSON" == "[]" ]] || [[ -z "$DOC_DIRS_JSON" ]]; then
        log_info "document_directories not configured, skipping"
    else
        # Build a comma-separated, ~-expanded directory list
        DOC_DIRS=""
        while IFS= read -r d; do
            expanded=$(expand_path "$d")
            DOC_DIRS+="${DOC_DIRS:+,}$expanded"
        done < <(echo "$DOC_DIRS_JSON" | jq -r '.[]')

        # Auto-excludes: report output dir, slack source dir, tool root, plus user list
        OUTPUT_DIR_ABS=$(expand_path "$(get_config "output_directory" "$HOME/Desktop")")
        AUTO_EXCLUDES="$OUTPUT_DIR_ABS,$SCRIPT_DIR"

        SLACK_DIR=$(get_config "slack_export_directory" "")
        if [[ -n "$SLACK_DIR" ]] && [[ "$SLACK_DIR" != "null" ]]; then
            AUTO_EXCLUDES+=",$(expand_path "$SLACK_DIR")"
        fi

        USER_EXCLUDES_JSON=$(get_config_array "document_exclude_patterns")
        USER_EXCLUDES=$(echo "$USER_EXCLUDES_JSON" | jq -r 'join(",")')
        if [[ -n "$USER_EXCLUDES" ]]; then
            AUTO_EXCLUDES+=",$USER_EXCLUDES"
        fi

        DOC_EXTS_JSON=$(get_config_array "document_extensions" '["md","pdf"]')
        DOC_EXTS=$(echo "$DOC_EXTS_JSON" | jq -r 'join(",")')

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

- [ ] **Step 4: Add the JSON merge block**

In the "Combine data from all sources" section (the cluster of `jq --slurpfile` blocks around `generate.sh:286-311`), append a new block immediately after the Linear merge and before the Slack merge:

```bash
# Add documents data if available
if [[ -f "$TEMP_DIR/documents.json" ]]; then
    jq --slurpfile documents "$TEMP_DIR/documents.json" \
        '.documents = $documents[0]' \
        "$COMBINED_JSON" > "$COMBINED_JSON.tmp" && mv "$COMBINED_JSON.tmp" "$COMBINED_JSON"
fi
```

- [ ] **Step 5: Smoke-test the wiring with only the documents collector**

```bash
cd /Users/jake/Documents/status-report
./generate.sh --month 2026-05 --collectors documents 2>&1 | tee /tmp/generate-doc-only.log | tail -30
```

Expected (do **not** worry about the final report quality yet — the LLM hasn't been told how to use documents until Task 8, so any document context will simply be ignored. The goal here is to see the collector run cleanly and the combined JSON contain the new field):

- Log includes `Running documents collector...` and `Documents collected`.
- Log includes the temp dir path (e.g., `/tmp/status-report-2026-05-XXXXXX`).
- That temp dir contains `documents.json` and `combined.json`.
- `combined.json` has a `.documents.documents` key with the collected files.

Verify by grabbing the temp dir from the log:

```bash
TEMP_DIR=$(grep -oE "/tmp/status-report-2026-05-[A-Za-z0-9]+" /tmp/generate-doc-only.log | head -1)
ls "$TEMP_DIR"
jq '.documents | {pdftotext_available, document_count: (.documents | length), skipped_count: (.skipped | length)}' "$TEMP_DIR/combined.json"
```

Expected: `documents.json` and `combined.json` listed; the `combined.json` contains a populated `.documents` block.

> Note: the end-to-end run will print an LLM-generation error if `claude-opus-4.7` is unavailable; that's fine for this step. The goal is collector+merge plumbing.

---

## Task 8: Add `DOCUMENT DATA HANDLING` to the system prompt

**Why:** Tell the LLM how to use the new field. Mirrors the existing `SLACK DATA HANDLING` block.

**Files:**
- Modify: `generate.sh` (the `SYSTEM_PROMPT` heredoc, currently at lines 347-377)

- [ ] **Step 1: Insert the new block immediately before `OUTPUT REQUIREMENTS`**

In `generate.sh`, locate the `SYSTEM_PROMPT` heredoc and insert this block on the blank line immediately before `OUTPUT REQUIREMENTS:`:

```
DOCUMENT DATA HANDLING:
- documents[] are markdown/PDF files the user authored or edited in this period
- Use them as context to enrich existing sections (Development, Operations, Infrastructure, Collaboration)
- A design doc, spec, or RFC indicates substantive work in Development or Infrastructure
- Meeting notes or status drafts indicate Collaboration
- Filenames and paths are private context - do NOT cite paths in the report
- Do NOT add a separate "Documents" or "Writing" section to the report
- If `truncated: true`, treat absent content as unknown rather than significant
- Documents with no clear connection to work activity should be ignored

```

The full surrounding context should look like (lines may shift):

```
...
- Thread summaries show collaborative work - extract the target user's role

DOCUMENT DATA HANDLING:
- documents[] are markdown/PDF files the user authored or edited in this period
... (rest of new block) ...

OUTPUT REQUIREMENTS:
- High-level bullet points (1-2 lines each) describing what was accomplished
...
```

- [ ] **Step 2: Smoke-test by printing the assembled prompt**

```bash
cd /Users/jake/Documents/status-report
# Extract the SYSTEM_PROMPT block from generate.sh and print it
awk "/read -r -d '' SYSTEM_PROMPT/,/^PROMPT_END/" generate.sh | grep -A2 "DOCUMENT DATA HANDLING"
```

Expected: prints the new heading and the first two bullet lines beneath it, proving the block landed inside the heredoc.

---

## Task 9: Update `README.md`

**Why:** Document the new config fields and the collector. The current README config table mentions `document_directories` with description "future use" — update it.

**Files:**
- Modify: `README.md` (config table around lines 49-58, Data Collectors section, and the file structure listing near the end)

- [ ] **Step 1: Update the config table row for `document_directories`**

Find this row in `README.md:54`:

```
| `document_directories` | Directories to scan for documents (future use) | No |
```

Replace it with:

```
| `document_directories` | Directories to recursively scan for markdown/PDF documents | No |
| `document_exclude_patterns` | Substrings; any match against a file's absolute path excludes it | No |
| `document_extensions` | File extensions to collect (default `["md","pdf"]`) | No |
| `document_max_file_bytes` | Per-file byte cap; longer files are truncated (default `20000`) | No |
```

- [ ] **Step 2: Add a Documents Collector subsection**

In the "Data Collectors" section, after the Linear collector subsection and before the Slack collector subsection, insert:

````markdown
### Documents Collector (`collectors/documents.py`)

Scans configured local directories for markdown and PDF files modified within the date range. Content is fed to the main report LLM call to enrich existing sections (Development, Operations, Collaboration) — it does NOT produce a dedicated "Documents" report section.

**Config fields used:**
- `document_directories` - Directories to scan recursively (required for this collector to run)
- `document_exclude_patterns` - Optional substrings excluded from results
- `document_extensions` - Optional extension list (default `md`, `pdf`)
- `document_max_file_bytes` - Optional per-file byte cap (default 20000)

**Auto-excluded paths:** the report output directory, the Slack source directory, and the status-report tool's own root are added to `exclude_patterns` so the collector never ingests its own outputs or already-collected sources.

**PDF handling:** PDFs are extracted via `pdftotext` (install with `brew install poppler`). If `pdftotext` is not on `PATH`, PDFs are listed under `skipped[]` and the collector still succeeds.

```bash
# Standalone usage
./collectors/documents.py \
  --start-date 2026-05-01 --end-date 2026-05-31 \
  --directories ~/Desktop,~/Documents \
  --extensions md,pdf \
  --exclude-patterns "/Users/me/Documents/old" \
  --max-file-bytes 20000 \
  --output documents.json
```
````

- [ ] **Step 3: Update the prerequisites list and file structure listing**

In the Prerequisites section near the top, add to the **Optional** list:

```
- **pdftotext** - PDF text extraction (`brew install poppler`), required only if collecting PDFs
```

In the File Structure section near the bottom of the README, update the `collectors/` listing to include `documents.py`:

```
├── collectors/
│   ├── github.py            # GitHub activity collector
│   ├── git-repos.sh         # Local git repos scanner
│   ├── linear.sh            # Linear issues collector
│   ├── documents.py         # Local markdown/PDF collector
│   └── slack.py             # Slack AI summary parser
```

- [ ] **Step 4: Smoke-test by reading the changes back**

```bash
grep -A1 "document_directories" /Users/jake/Documents/status-report/README.md | head -5
grep "Documents Collector" /Users/jake/Documents/status-report/README.md
grep "documents.py" /Users/jake/Documents/status-report/README.md
```

Expected: all three greps return lines, including the new subsection header and the file-structure listing.

---

## Task 10: End-to-end smoke test for May 2026

**Why:** Confirm the full pipeline produces a sensible report, no "Documents" section appears, and document context shows up woven into existing sections.

**Files:** None modified. This task only runs and inspects.

- [ ] **Step 1: Run the full generator**

```bash
cd /Users/jake/Documents/status-report
./generate.sh --month 2026-05 2>&1 | tee /tmp/generate-2026-05.log | tail -40
```

Expected (high level):
- Log lines for GitHub, Git, Linear, Documents collectors. Slack only runs if `slack` is in the collector list (it's not in the new default).
- `Documents collected` appears with no error.
- The final report file is written to `~/Documents/status-report/reports/status-report-2026-05.md`.

- [ ] **Step 2: Verify document content was passed to the LLM**

Grab the temp dir from the log and inspect the combined JSON:

```bash
TEMP_DIR=$(grep -oE "/tmp/status-report-2026-05-[A-Za-z0-9]+" /tmp/generate-2026-05.log | head -1)
jq '.documents | {document_count: (.documents | length), skipped_count: (.skipped | length), pdftotext_available, sample: (.documents[0] | {name, extension, mtime, truncated})}' "$TEMP_DIR/combined.json"
```

Expected: nonzero `document_count`, a sample doc populated. Skipped is OK to be nonzero if pdftotext rejected anything.

- [ ] **Step 3: Confirm none of the auto-excluded paths leaked in**

```bash
jq -r '.documents.documents[].path' "$TEMP_DIR/combined.json" | grep -E "status-report/reports|slack_summaries" \
  && echo "FAIL: auto-excluded path made it through" \
  || echo "OK: no auto-excluded paths in collected documents"
```

Expected: `OK: no auto-excluded paths in collected documents`.

- [ ] **Step 4: Inspect the generated report**

```bash
cat ~/Documents/status-report/reports/status-report-2026-05.md
```

Look for:
- The report contains the usual sections (Development, Operations, Infrastructure, Collaboration, etc.).
- There is **no** section titled "Documents", "Writing", or anything that looks like a raw file list.
- The bullets describe work, not file paths (verify with `grep -E "\.md|\.pdf|/Users/" ~/Documents/status-report/reports/status-report-2026-05.md` — expect zero matches, or only matches inside code references that the user has accepted).

- [ ] **Step 5: Confirm the pdftotext-missing path works in the full pipeline**

```bash
cd /Users/jake/Documents/status-report
PATH="/usr/bin:/bin" ./generate.sh --month 2026-05 --collectors documents 2>&1 | grep -E "pdftotext|Documents collected|Documents collector failed"
```

Expected: warning about missing pdftotext, collector still succeeds (`Documents collected`).

---

## Done

After Task 10 passes, the feature is complete: documents are collected, fed to the LLM with auto-excludes preventing self-ingestion, and the rendered report weaves them into the existing sections without a new "Documents" header.
