# Status Report Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amendment (2026-06-30, during execution):** Slack is no longer a scripted collector.
> `slack.py` ignored the date range and parsed the whole folder with brittle regex, so it
> was dropped — the agent now reads the week's summary file `slack-<START_DATE>.md`
> directly and asks the user if it is missing. Net effect on the tasks below: Task 2 does
> **not** copy `slack.py`; Task 3's `collect.sh` does **not** run a Slack collector and
> merges only `github git documents`; Task 5's `SKILL.md` gains a "read the week's Slack
> file / ask if missing" step. The live skill files are authoritative for this change.
> Config fixes also applied during execution: `github_org` → `abridgeai`,
> `slack_export_directory` → `~/Documents/status-report/slack_summaries`.

**Goal:** Convert the `bash` + `llm`-CLI status report generator into a self-contained global Claude Code skill where the agent performs synthesis, Linear and Google Calendar are collected via MCP, and deterministic sources stay scripted.

**Architecture:** A skill at `~/.claude/skills/status-report/` bundles the deterministic collectors (github, git, documents, slack) plus a single `collect.sh` orchestrator that resolves the date range, runs those collectors, and merges their output into `combined.json` — making no LLM call. `SKILL.md` then directs the agent to gather Linear and Google Calendar via MCP, synthesize the report following `reference/report-style.md`, and write it to the configured output directory. Personal settings live at `~/.config/status-report/config.json`.

**Tech Stack:** Bash, Python 3, `jq`, `gh` CLI, macOS `date`, Linear MCP, Google Calendar MCP.

## Global Constraints

- Skill location: `~/.claude/skills/status-report/` (self-contained, portable).
- Config location: `~/.config/status-report/config.json` (honor `$XDG_CONFIG_HOME` if set, else `~/.config`). No `llm_model` key.
- Default reporting period: previous complete calendar week, Monday–Sunday.
- Output directory: `config.output_directory` (stays `~/Documents/status-report/reports`).
- Output filename: weekly → `status-report-<ISO-year>-W<ISO-week>.md`; monthly → `status-report-YYYY-MM.md`; custom range → `status-report-<start>_to_<end>.md`.
- `collect.sh` makes **no** LLM call and never touches Linear or Calendar.
- Per-collector failures warn and continue; the merged JSON omits sources that produced nothing.
- Synthesis rule: use only collected data; never fabricate activity.
- The existing repo (`~/Documents/status-report/`) keeps `reports/`, `slack_summaries/`, `docs/`, `README.md`, `SLACK_PROMPT.md` untouched. Only `generate.sh`, `collectors/`, `lib/`, and `config.json` are removed from it.
- The skill files live outside this git repo and are not version-controlled by it; only repo-local changes (spec, plan, deletions) get committed, and only on a branch (never directly on `main`).

---

## File Structure

Created under `~/.claude/skills/status-report/`:

- `SKILL.md` — agent instructions: period resolution, run the orchestrator, Linear MCP steps, Calendar MCP steps, synthesis, output.
- `scripts/collect.sh` — orchestrator: resolve date range, run scriptable collectors, merge to `combined.json`, print resolved range + paths + output stem.
- `scripts/github.py` — gh GraphQL collector (copied verbatim).
- `scripts/git-repos.sh` — local git scanner (copied verbatim).
- `scripts/documents.py` — local md/pdf collector (copied verbatim).
- `scripts/slack.py` — optional Slack summary parser (copied verbatim).
- `scripts/lib/common.sh` — shared bash helpers (copied, with two changes: config path + `get_last_week`).
- `reference/report-style.md` — synthesis guidance migrated from the old system prompt, plus a new calendar block.

Created under `~/.config/status-report/`:

- `config.json` — migrated from the repo, minus `llm_model`.

Removed from `~/Documents/status-report/`:

- `generate.sh`, `collectors/`, `lib/`, `config.json`.

---

## Task 1: Scaffold skill tree and migrate config

**Files:**
- Create: `~/.claude/skills/status-report/scripts/lib/` (directory)
- Create: `~/.claude/skills/status-report/reference/` (directory)
- Create: `~/.config/status-report/config.json`

**Interfaces:**
- Produces: `~/.config/status-report/config.json` containing every key from the repo's `config.json` except `llm_model`.

- [ ] **Step 1: Create the directory tree**

```bash
mkdir -p ~/.claude/skills/status-report/scripts/lib
mkdir -p ~/.claude/skills/status-report/reference
mkdir -p ~/.config/status-report
```

- [ ] **Step 2: Migrate config.json, dropping llm_model**

```bash
jq 'del(.llm_model)' ~/Documents/status-report/config.json > ~/.config/status-report/config.json
```

- [ ] **Step 3: Verify the config is valid and has no llm_model**

Run:
```bash
jq -e 'has("llm_model") | not' ~/.config/status-report/config.json && \
jq -r '.output_directory, .github_org, .git_email' ~/.config/status-report/config.json
```
Expected: prints `true`, then `~/Documents/status-report/reports`, `abridge`, `<work-email>` (no error).

---

## Task 2: Copy collectors and adapt common.sh

The four deterministic collectors are copied verbatim. `common.sh` gets exactly two changes: the default config path and a new `get_last_week` helper.

**Files:**
- Create: `~/.claude/skills/status-report/scripts/github.py` (copy of `collectors/github.py`)
- Create: `~/.claude/skills/status-report/scripts/git-repos.sh` (copy of `collectors/git-repos.sh`)
- Create: `~/.claude/skills/status-report/scripts/documents.py` (copy of `collectors/documents.py`)
- Create: `~/.claude/skills/status-report/scripts/slack.py` (copy of `collectors/slack.py`)
- Create: `~/.claude/skills/status-report/scripts/lib/common.sh` (copy of `lib/common.sh`, then edited)

**Interfaces:**
- Produces: `common.sh` with `DEFAULT_CONFIG` pointing at the XDG path and a `get_last_week` function printing `"<YYYY-MM-DD> <YYYY-MM-DD>"` (previous Monday and Sunday, space-separated).
- Consumes: the collectors' existing CLI flags (`--start-date`, `--end-date`, `--output`, plus collector-specific flags) — unchanged from the repo.

- [ ] **Step 1: Copy the four collectors and common.sh**

```bash
SRC=~/Documents/status-report
DST=~/.claude/skills/status-report/scripts
cp "$SRC/collectors/github.py"     "$DST/github.py"
cp "$SRC/collectors/git-repos.sh"  "$DST/git-repos.sh"
cp "$SRC/collectors/documents.py"  "$DST/documents.py"
cp "$SRC/collectors/slack.py"      "$DST/slack.py"
cp "$SRC/lib/common.sh"            "$DST/lib/common.sh"
chmod +x "$DST"/*.py "$DST"/*.sh
```

- [ ] **Step 2: Point DEFAULT_CONFIG at the XDG path**

In `~/.claude/skills/status-report/scripts/lib/common.sh`, replace:

```bash
# Default config file location
DEFAULT_CONFIG="$SCRIPT_DIR/config.json"
```

with:

```bash
# Default config file location (XDG-style, outside the skill tree)
DEFAULT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/status-report/config.json"
```

- [ ] **Step 3: Add the get_last_week helper**

In the same `common.sh`, immediately after the `get_last_month()` function, add:

```bash
# Get the previous complete calendar week (Monday-Sunday) as "START END"
# Both dates in YYYY-MM-DD. Uses macOS `date`.
get_last_week() {
    local dow this_monday last_monday last_sunday
    dow=$(date "+%u")  # 1=Mon .. 7=Sun
    # Monday of the current week
    this_monday=$(date -j -v-$((dow - 1))d "+%Y-%m-%d")
    # Previous week's Monday and Sunday
    last_monday=$(date -j -f "%Y-%m-%d" -v-7d "$this_monday" "+%Y-%m-%d")
    last_sunday=$(date -j -f "%Y-%m-%d" -v+6d "$last_monday" "+%Y-%m-%d")
    echo "$last_monday $last_sunday"
}
```

- [ ] **Step 4: Verify get_last_week returns a Monday–Sunday 7-day span**

Run:
```bash
source ~/.claude/skills/status-report/scripts/lib/common.sh
read -r LW_START LW_END <<< "$(get_last_week)"
echo "start=$LW_START ($(date -j -f '%Y-%m-%d' "$LW_START" '+%u'))  end=$LW_END ($(date -j -f '%Y-%m-%d' "$LW_END" '+%u'))"
# span in days (should be 6)
echo "span=$(( ( $(date -j -f '%Y-%m-%d' "$LW_END" '+%s') - $(date -j -f '%Y-%m-%d' "$LW_START" '+%s') ) / 86400 ))"
```
Expected: start day-of-week `1` (Monday), end day-of-week `7` (Sunday), `span=6`. Run on 2026-06-30 this prints `start=2026-06-22 (1) end=2026-06-28 (7)` and `span=6`.

- [ ] **Step 5: Verify a collector runs standalone against the XDG config**

Run (git collector needs no network, good smoke test):
```bash
source ~/.claude/skills/status-report/scripts/lib/common.sh
load_config
REPOS=$(expand_path "$(get_config repos_directory "$HOME/Code")")
EMAIL=$(get_config git_email)
~/.claude/skills/status-report/scripts/git-repos.sh \
  --start-date 2026-06-22 --end-date 2026-06-28 \
  --email "$EMAIL" --repos-dir "$REPOS" --output /tmp/git-smoke.json
jq -e '.summary' /tmp/git-smoke.json
```
Expected: the script reports a summary line on stderr and `/tmp/git-smoke.json` contains a `summary` object (the `jq -e` exits 0).

---

## Task 3: Write the collect.sh orchestrator

`collect.sh` resolves the date range from one of three modes, runs the scriptable collectors (reusing the logic from `generate.sh` lines 168–372, minus Linear), merges to `combined.json`, and prints machine-readable lines for the agent. It makes no LLM call.

**Files:**
- Create: `~/.claude/skills/status-report/scripts/collect.sh`

**Interfaces:**
- Consumes: `lib/common.sh` (`load_config`, `get_config`, `get_config_array`, `expand_path`, `get_month_range`, `get_last_week`, `validate_date`, `create_temp_dir`, log helpers); the four collectors via `--start-date/--end-date/--output` plus their existing flags.
- Produces: on stdout, exactly these `KEY=VALUE` lines (last lines of output): `WORK_DIR=`, `COMBINED_JSON=`, `START_DATE=`, `END_DATE=`, `OUTPUT_STEM=`. `combined.json` has shape `{ "date_range": {start,end}, "github": {...}, "git": {...}, "documents": {...}, "slack": {...} }` with absent sources omitted.

- [ ] **Step 1: Write collect.sh**

Create `~/.claude/skills/status-report/scripts/collect.sh` with exactly this content:

```bash
#!/bin/bash
#
# Status Report Collector
#
# Resolves a date range, runs the deterministic collectors (github, git,
# documents, slack), and merges their output into combined.json.
# Makes NO LLM call and does NOT touch Linear or Google Calendar — those
# are gathered by the agent via MCP.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

MODE=""          # last-week | month | range
MONTH=""
START_DATE=""
END_DATE=""

usage() {
    cat <<EOF
Usage: $(basename "$0") [--last-week | --month YYYY-MM | --start-date YYYY-MM-DD --end-date YYYY-MM-DD]

Resolves a reporting period, runs the deterministic collectors, and writes
combined.json. Defaults to --last-week if no mode is given.
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --last-week) MODE="last-week"; shift ;;
        --month) MODE="month"; MONTH="$2"; shift 2 ;;
        --start-date) START_DATE="$2"; shift 2 ;;
        --end-date) END_DATE="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) log_error "Unknown option: $1"; usage ;;
    esac
done

check_requirements jq gh git python3 || exit 1

if ! load_config; then
    log_error "Create your config at ${XDG_CONFIG_HOME:-$HOME/.config}/status-report/config.json"
    exit 1
fi

# --- Resolve date range and output filename stem ---
if [[ -n "$START_DATE" || -n "$END_DATE" ]]; then
    [[ -n "$START_DATE" && -n "$END_DATE" ]] || { log_error "Both --start-date and --end-date are required for a custom range"; exit 1; }
    validate_date "$START_DATE" || { log_error "Invalid start date: $START_DATE"; exit 1; }
    validate_date "$END_DATE"   || { log_error "Invalid end date: $END_DATE"; exit 1; }
    OUTPUT_STEM="status-report-${START_DATE}_to_${END_DATE}"
elif [[ "$MODE" == "month" ]]; then
    read -r START_DATE END_DATE <<< "$(get_month_range "$MONTH")"
    [[ -n "$START_DATE" ]] || { log_error "Failed to parse month: $MONTH"; exit 1; }
    OUTPUT_STEM="status-report-${MONTH}"
else
    # default: previous complete calendar week
    read -r START_DATE END_DATE <<< "$(get_last_week)"
    OUTPUT_STEM="status-report-$(date -j -f "%Y-%m-%d" "$START_DATE" "+%G-W%V")"
fi

log_info "Reporting period: $START_DATE to $END_DATE"

TEMP_DIR=$(create_temp_dir "status-report")
log_info "Working directory: $TEMP_DIR"

declare -a SUCCESSFUL_COLLECTORS=()

# --- GitHub ---
GITHUB_ORG=$(get_config github_org)
if [[ -n "$GITHUB_ORG" ]]; then
    log_info "Running GitHub collector..."
    if "$SCRIPT_DIR/github.py" --start-date "$START_DATE" --end-date "$END_DATE" \
        --org "$GITHUB_ORG" --output "$TEMP_DIR/github.json"; then
        SUCCESSFUL_COLLECTORS+=("github"); log_success "GitHub data collected"
    else
        log_warn "GitHub collector failed"
    fi
else
    log_warn "github_org not configured, skipping GitHub"
fi

# --- Local git ---
GIT_EMAIL=$(get_config git_email)
REPOS_DIR=$(expand_path "$(get_config repos_directory "$HOME/Code")")
if [[ -n "$GIT_EMAIL" ]]; then
    log_info "Running git repositories scanner..."
    if "$SCRIPT_DIR/git-repos.sh" --start-date "$START_DATE" --end-date "$END_DATE" \
        --email "$GIT_EMAIL" --repos-dir "$REPOS_DIR" --output "$TEMP_DIR/git.json"; then
        SUCCESSFUL_COLLECTORS+=("git"); log_success "Git repositories scanned"
    else
        log_warn "Git scanner failed"
    fi
else
    log_warn "git_email not configured, skipping git"
fi

# --- Documents ---
DOC_DIRS_JSON=$(get_config_array document_directories)
if [[ "$DOC_DIRS_JSON" != "[]" && -n "$DOC_DIRS_JSON" ]]; then
    log_info "Running documents collector..."
    DOC_DIRS=""
    while IFS= read -r d; do
        DOC_DIRS+="${DOC_DIRS:+,}$(expand_path "$d")"
    done < <(echo "$DOC_DIRS_JSON" | jq -r '.[]')

    OUTPUT_DIR_ABS=$(expand_path "$(get_config output_directory "$HOME/Desktop")")
    AUTO_EXCLUDES="$OUTPUT_DIR_ABS,$SCRIPT_DIR"
    SLACK_DIR=$(get_config slack_export_directory "")
    if [[ -n "$SLACK_DIR" && "$SLACK_DIR" != "null" ]]; then
        AUTO_EXCLUDES+=",$(expand_path "$SLACK_DIR")"
    fi
    USER_EXCLUDES=$(get_config_array document_exclude_patterns | jq -r 'join(",")')
    [[ -n "$USER_EXCLUDES" ]] && AUTO_EXCLUDES+=",$USER_EXCLUDES"
    DOC_EXTS=$(get_config_array document_extensions '["md","pdf"]' | jq -r 'join(",")')
    DOC_MAX_BYTES=$(get_config document_max_file_bytes "20000")

    if "$SCRIPT_DIR/documents.py" --start-date "$START_DATE" --end-date "$END_DATE" \
        --directories "$DOC_DIRS" --extensions "$DOC_EXTS" \
        --exclude-patterns "$AUTO_EXCLUDES" --max-file-bytes "$DOC_MAX_BYTES" \
        --output "$TEMP_DIR/documents.json"; then
        SUCCESSFUL_COLLECTORS+=("documents"); log_success "Documents collected"
    else
        log_warn "Documents collector failed"
    fi
else
    log_info "document_directories not configured, skipping documents"
fi

# --- Slack (optional) ---
SLACK_DIR=$(get_config slack_export_directory)
SLACK_USER=$(get_config slack_user_name)
if [[ -n "$SLACK_DIR" && "$SLACK_DIR" != "null" ]]; then
    SLACK_DIR=$(expand_path "$SLACK_DIR")
    if [[ -z "$SLACK_USER" || "$SLACK_USER" == "null" ]]; then
        log_warn "slack_user_name not configured, skipping Slack"
    else
        log_info "Running Slack parser..."
        if "$SCRIPT_DIR/slack.py" --start-date "$START_DATE" --end-date "$END_DATE" \
            --input "$SLACK_DIR" --user "$SLACK_USER" --output "$TEMP_DIR/slack.json"; then
            SUCCESSFUL_COLLECTORS+=("slack"); log_success "Slack data parsed"
        else
            log_warn "Slack parser failed"
        fi
    fi
fi

# --- Merge ---
COMBINED_JSON="$TEMP_DIR/combined.json"
echo "{\"date_range\":{\"start\":\"$START_DATE\",\"end\":\"$END_DATE\"}}" > "$COMBINED_JSON"
for src in github git documents slack; do
    if [[ -f "$TEMP_DIR/$src.json" ]]; then
        jq --slurpfile s "$TEMP_DIR/$src.json" ". + {\"$src\": \$s[0]}" \
            "$COMBINED_JSON" > "$COMBINED_JSON.tmp" && mv "$COMBINED_JSON.tmp" "$COMBINED_JSON"
    fi
done

log_success "Collected from: ${SUCCESSFUL_COLLECTORS[*]:-none}"

# --- Machine-readable output for the agent ---
echo "WORK_DIR=$TEMP_DIR"
echo "COMBINED_JSON=$COMBINED_JSON"
echo "START_DATE=$START_DATE"
echo "END_DATE=$END_DATE"
echo "OUTPUT_STEM=$OUTPUT_STEM"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x ~/.claude/skills/status-report/scripts/collect.sh
```

- [ ] **Step 3: Verify default (last-week) mode produces a valid combined.json and correct stem**

Run:
```bash
~/.claude/skills/status-report/scripts/collect.sh 2>/tmp/collect.err | tee /tmp/collect.out
COMBINED=$(grep '^COMBINED_JSON=' /tmp/collect.out | cut -d= -f2-)
jq -e '.date_range.start and .date_range.end' "$COMBINED"
grep '^OUTPUT_STEM=' /tmp/collect.out
```
Expected: on 2026-06-30, stderr shows period `2026-06-22 to 2026-06-28`; `jq -e` exits 0; `OUTPUT_STEM=status-report-2026-W26`.

- [ ] **Step 4: Verify month and custom-range stems**

Run:
```bash
~/.claude/skills/status-report/scripts/collect.sh --month 2026-05 2>/dev/null | grep -E '^(START_DATE|END_DATE|OUTPUT_STEM)='
~/.claude/skills/status-report/scripts/collect.sh --start-date 2026-06-01 --end-date 2026-06-10 2>/dev/null | grep '^OUTPUT_STEM='
```
Expected: month mode prints `START_DATE=2026-05-01`, `END_DATE=2026-05-31`, `OUTPUT_STEM=status-report-2026-05`; range mode prints `OUTPUT_STEM=status-report-2026-06-01_to_2026-06-10`.

---

## Task 4: Write reference/report-style.md

Migrate the synthesis guidance from `generate.sh` (the `SYSTEM_PROMPT` heredoc, lines 405–445) into a reference doc, and add the new calendar block.

**Files:**
- Create: `~/.claude/skills/status-report/reference/report-style.md`

**Interfaces:**
- Consumes: nothing (static reference).
- Produces: a markdown doc `SKILL.md` points at for synthesis rules.

- [ ] **Step 1: Write the reference doc**

Create `~/.claude/skills/status-report/reference/report-style.md` with exactly this content:

````markdown
# Report Style & Synthesis Guidance

You are helping an SRE contractor create a status report for their account manager (not the client directly).

INPUT: collected data containing GitHub activity, local git commits, Linear issues, Google Calendar meetings, local documents, and Slack thread summaries. Any source may be absent.

## SLACK DATA HANDLING
- Slack data contains thread summaries where the target_user participated.
- Focus on contributions made by the target_user (specified in `slack.target_user`).
- Use the full thread context to understand what was accomplished.
- Credit specific work to the target user only when they are explicitly mentioned.
- When multiple people contributed, describe what the target user specifically did.

## DOCUMENT DATA HANDLING
- `documents[]` are markdown/PDF files the user authored or edited in this period.
- Use them as context to enrich existing sections (Development, Operations, Infrastructure, Collaboration).
- A design doc, spec, or RFC indicates substantive work in Development or Infrastructure.
- Meeting notes or status drafts indicate Collaboration.
- Filenames and paths are private context — do NOT cite paths in the report.
- Do NOT add a separate "Documents" or "Writing" section.
- If `truncated: true`, treat absent content as unknown rather than significant.
- Documents with no clear connection to work activity should be ignored.

## CALENDAR DATA HANDLING
- Calendar data lists accepted meetings (the user was not declined and there was at least one other attendee) within the period.
- Use meetings to enrich the **Collaboration** section as context (e.g., "Led working sessions on X", "Coordinated with team on Y").
- When the user was the organizer, frame it as leading/driving; otherwise as participating/contributing.
- Summarize recurring meetings (standups, regular 1:1s) as a single line rather than listing each instance.
- Do NOT add a dedicated "Meetings" or "Calendar" section, and do NOT list events verbatim.
- Meetings with no clear connection to work outcomes should be ignored.

## OUTPUT REQUIREMENTS
- High-level bullet points (1–2 lines each) describing what was accomplished.
- Sub-bullets ONLY for important context about why/impact.
- Group into categories: Site Reliability Engineering, Code Reviews, Operations, Collaboration.
- Focus on BUSINESS VALUE and outcomes, not technical implementation details.
- Technologies can be mentioned but avoid deep technical jargon.
- Deduplicate related work (commits that became PRs = single bullet).

## STYLE EXAMPLE
- Investigated & Implemented a Reauthentication popup for SOAP Dashboard
    - To streamline MFA Setup process, which Annie agreed was too cumbersome
- Streamlined Email Validation flow for mobile
- Fixed a bug in email verification workflow
    - keeping records in sync when logged out, gracefully handling out-of-sync records
- Requested, tested and demoed new AI workflow with Cursor + Linear

## FORMAT
Plain markdown with clear section headers. NO introduction paragraph — start directly with the sections.
````

- [ ] **Step 2: Verify the file exists and contains the calendar block**

Run:
```bash
grep -c "CALENDAR DATA HANDLING" ~/.claude/skills/status-report/reference/report-style.md
```
Expected: `1`.

---

## Task 5: Write SKILL.md

`SKILL.md` is the agent's entry point: when to activate, how to resolve the period, the single collect command, the Linear and Calendar MCP steps, synthesis, and output.

**Files:**
- Create: `~/.claude/skills/status-report/SKILL.md`

**Interfaces:**
- Consumes: `scripts/collect.sh` output lines (`WORK_DIR`, `COMBINED_JSON`, `START_DATE`, `END_DATE`, `OUTPUT_STEM`); `reference/report-style.md`; Linear MCP tools (`list_issues`, `get_user`/identity); Google Calendar MCP tools (`list_events`).
- Produces: a markdown report written to `config.output_directory/<OUTPUT_STEM>.md`.

- [ ] **Step 1: Write SKILL.md**

Create `~/.claude/skills/status-report/SKILL.md` with exactly this content:

````markdown
---
name: status-report
description: Generate a status report of the user's work activity (GitHub, git, Linear, Google Calendar, documents, Slack). Use when the user asks to "generate/create my status report", a "weekly status report", or a "monthly status report". Defaults to the previous full week.
---

# Status Report

Generate an executive-level status report from the user's work activity. Deterministic
sources are collected by a script; Linear and Google Calendar are collected by you via MCP;
you write the report.

## 1. Resolve the reporting period

Pick ONE mode from the user's request:

- No period stated → previous full week (default). Run `collect.sh` with no flags.
- A month like "May" or "2026-05" → `--month 2026-05`.
- An explicit date range → `--start-date YYYY-MM-DD --end-date YYYY-MM-DD`.

## 2. Run the collector (one command)

```bash
~/.claude/skills/status-report/scripts/collect.sh [--month YYYY-MM | --start-date ... --end-date ...]
```

Read these lines from its stdout: `WORK_DIR`, `COMBINED_JSON`, `START_DATE`, `END_DATE`,
`OUTPUT_STEM`. Then read the `COMBINED_JSON` file — it holds the github, git, documents,
and slack data plus the `date_range`. If the script exits non-zero because config is
missing, tell the user to create `~/.config/status-report/config.json` and stop.

## 3. Collect Linear via MCP

Using `START_DATE`/`END_DATE` from step 2:

1. Resolve the current Linear user (the authenticated identity / "me").
2. List issues assigned to that user. Bucket them:
   - **completed**: state is a completed/Done-type state and `updatedAt` is within range.
   - **created**: `createdAt` is within range.
   - **updated**: `updatedAt` is within range and the issue is not already in completed or created.
3. For each issue keep: identifier, title, description, url, state, the relevant
   timestamp(s), labels, assignee, team, priority.

If the Linear MCP is unavailable or unauthenticated, note it to the user and continue.

## 4. Collect Google Calendar via MCP

Using `START_DATE`/`END_DATE`:

1. List events on the user's calendars within the range.
2. Keep an event ONLY if the user's response is **not declined** AND it has **at least one
   other attendee**. Drop all-day events and solo/focus blocks (no other attendees).
3. For each kept event keep: title, start, end (or duration), other attendees, and whether
   the user was the organizer.

If the Google Calendar MCP is unavailable or unauthenticated, note it to the user and continue.

## 5. Synthesize the report

Read `~/.claude/skills/status-report/reference/report-style.md` and follow it exactly.
Combine the `COMBINED_JSON` contents with the Linear and Calendar results you gathered.

**Hard rule:** use only collected data. Never fabricate activity. If every source came back
empty, tell the user you cannot produce a report rather than inventing content.

## 6. Write the report and preview

1. Read `output_directory` from `~/.config/status-report/config.json`
   (`jq -r '.output_directory' ~/.config/status-report/config.json`, expand a leading `~`).
2. Write the report to `<output_directory>/<OUTPUT_STEM>.md` using this structure:

   ```markdown
   # Status Report - <Month Year or period>

   **Period:** <START_DATE> to <END_DATE>

   ---

   <your synthesized sections>

   ---

   *Report generated on <YYYY-MM-DD HH:MM:SS>*
   ```

3. Tell the user the output path and show the first ~20 lines as a preview.
````

- [ ] **Step 2: Verify the frontmatter parses and the description triggers correctly**

Run:
```bash
head -4 ~/.claude/skills/status-report/SKILL.md
grep -c "collect.sh" ~/.claude/skills/status-report/SKILL.md
```
Expected: frontmatter shows `name: status-report` and a description mentioning status report; `collect.sh` appears at least once.

- [ ] **Step 3: End-to-end dry run of the skill**

In a new Claude Code session (so the skill loads), ask: "generate my status report". Confirm the agent:
- runs `collect.sh` with no flags (previous week),
- gathers Linear and Calendar via MCP (or notes if unavailable),
- writes `status-report-<ISO-week>.md` to `~/Documents/status-report/reports/`,
- and the report has the standard header and category sections with no fabricated content.

Eyeball it against an existing report in `~/Documents/status-report/reports/` for parity.

---

## Task 6: Remove the superseded scripts from the repo

Now that the skill is self-contained, delete only the unused executable scripts and the now-migrated config from the repo. Leave `reports/`, `slack_summaries/`, `docs/`, `README.md`, and `SLACK_PROMPT.md` untouched.

**Files:**
- Delete: `~/Documents/status-report/generate.sh`
- Delete: `~/Documents/status-report/collectors/` (whole directory)
- Delete: `~/Documents/status-report/lib/` (whole directory)
- Delete: `~/Documents/status-report/config.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a cleaned repo whose only role is to hold report outputs and docs.

- [ ] **Step 1: Confirm the skill works before deleting anything**

Run:
```bash
test -f ~/.claude/skills/status-report/scripts/collect.sh && \
test -f ~/.claude/skills/status-report/SKILL.md && \
test -f ~/.config/status-report/config.json && echo "skill+config present"
```
Expected: prints `skill+config present`. If not, stop — do not delete repo files.

- [ ] **Step 2: Create a branch (never commit on main)**

```bash
cd ~/Documents/status-report
git checkout -b convert-status-report-to-skill
```

- [ ] **Step 3: Delete the superseded files**

```bash
cd ~/Documents/status-report
git rm -r collectors lib generate.sh config.json
# documents.py was untracked; ensure it's gone too
rm -f collectors/documents.py 2>/dev/null || true
```

- [ ] **Step 4: Verify the kept paths are intact**

Run:
```bash
cd ~/Documents/status-report
ls reports slack_summaries docs README.md SLACK_PROMPT.md >/dev/null && echo "kept paths intact"
ls generate.sh collectors lib config.json 2>/dev/null || echo "superseded files gone"
```
Expected: prints `kept paths intact` then `superseded files gone`.

- [ ] **Step 5: Commit the conversion (repo-local changes only)**

```bash
cd ~/Documents/status-report
git add docs/superpowers/specs/2026-06-30-status-report-skill-design.md \
        docs/superpowers/plans/2026-06-30-status-report-skill.md
git commit -m "$(cat <<'EOF'
Convert status report generator to a Claude Code skill

Remove the bash + llm-CLI generator (generate.sh, collectors/, lib/,
config.json) now that a self-contained skill at ~/.claude/skills/status-report/
performs collection and synthesis. The repo now only holds report outputs
and design docs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Confirm the working tree is clean and on the branch**

Run:
```bash
cd ~/Documents/status-report && git status --short && git branch --show-current
```
Expected: no staged/unstaged changes remain from this task; current branch is `convert-status-report-to-skill`.

---

## Self-Review Notes

- **Spec coverage:** synthesis-to-agent (Tasks 4–5), Linear via MCP (Task 5 §3), Calendar via MCP + filter (Task 5 §4, report-style §CALENDAR), scripted collection (Tasks 2–3), config at XDG path minus llm_model (Tasks 1–2), previous-week default + ISO-week naming (Tasks 2–3), output location unchanged (Task 5 §6), repo cleanup keeping data (Task 6), error handling (collect.sh warnings + SKILL.md MCP-unavailable + no-fabrication rule). All spec sections map to a task.
- **MCP tool names:** SKILL.md describes Linear/Calendar steps behaviorally rather than hard-coding exact tool signatures, because the agent selects the connected MCP's tools at runtime; the buckets and filters are fully specified so the behavior is deterministic.
- **Commits:** only repo-local files are committed, on a branch, per the user's commit policy. The skill files under `~/.claude/skills/` and `~/.config/` are not in this repo and are verified by running them instead.
