# Status Report Skill — Design

**Date:** 2026-06-30
**Status:** Implemented (Tasks 1–5); repo cleanup (Task 6) on hold.

> **Amendment (2026-06-30, during implementation):** Slack moved from a scripted
> collector to an agent-read source. `slack.py` ignored the date range and parsed the
> whole folder with brittle regex; now that the agent does synthesis it simply reads the
> week's summary file directly. See the Slack notes below. Config fixes also applied:
> `github_org` corrected to `abridgeai`, and `slack_export_directory` corrected to
> `~/Documents/status-report/slack_summaries`. `github.py` was rewritten to use the
> `gh search` API instead of GraphQL `contributionsCollection` (which silently dropped
> private-repo contributions into `restrictedContributionsCount` and returned 0); it now
> has unit tests at `scripts/test_github.py`.

## Overview

Convert the existing `bash` + `llm`-CLI status report generator into a self-contained
global Claude Code skill at `~/.claude/skills/status-report/`.

Four core changes from the current tool:

1. **Synthesis moves to the agent.** The `llm` CLI call and the embedded heredoc prompts
   in `generate.sh` are removed. The agent running the skill reads the collected data and
   writes the report itself.
2. **Linear moves to the connected Linear MCP.** This drops the fragile `linear-cli` /
   `cargo` dependency. The old `collectors/linear.sh` is not carried into the skill.
3. **Google Calendar is added as a new source via the Google Calendar MCP.** Accepted
   meetings with other attendees enrich the existing Collaboration section. This is the
   only net-new source.
4. **Collection stays scripted where it is deterministic.** GitHub, local git, and
   documents remain bundled scripts so the agent runs a single command rather than
   orchestrating that collection by hand. Slack, Linear, and Calendar are agent-gathered
   (Slack by reading the week's summary file; Linear and Calendar via MCP).

## Goals

- A portable, self-contained skill that generates a status report on request.
- Default reporting period of the **previous complete calendar week (Monday–Sunday)**,
  overridable with a month or an explicit date range stated in the request.
- Keep deterministic data gathering in scripts; use MCP only where it is clearly better
  or required (Linear, Google Calendar).
- Personal settings live outside the skill tree so they survive skill reinstalls.

## Non-Goals

- No data sources beyond the six covered here (GitHub, git, Linear, documents, Slack,
  Google Calendar).
- No change to the report's editorial style, sections, or framing — the existing system
  prompt's guidance is preserved verbatim.
- No per-document LLM summarization or other new processing.

## Directory Layout

```
~/.claude/skills/status-report/
├── SKILL.md                 # instructions the agent follows
├── scripts/
│   ├── collect.sh           # orchestrator: runs scriptable collectors → combined.json
│   ├── github.py            # gh GraphQL collector (copied from repo)
│   ├── git-repos.sh         # local git scanner (copied from repo)
│   ├── documents.py         # local md/pdf collector (copied from repo)
│   └── lib/common.sh        # shared bash helpers (copied from repo)
└── reference/
    └── report-style.md      # synthesis guidance + style example (from old system prompt)
```

- `collectors/linear.sh` is **not** copied; Linear is handled via MCP.
- `slack.py` is **not** carried into the skill; the agent reads the week's Slack summary
  file directly (see Slack handling in the run flow).
- `config.json` is **not** stored in the skill tree (see Config).

## Config

Personal settings live at `~/.config/status-report/config.json` (XDG-style).
`collect.sh` resolves this path honoring `$XDG_CONFIG_HOME` if set, else `~/.config`.

The file is the repo's current `config.json` **minus `llm_model`** (no longer used — the
agent is the model). Keys retained:

- `git_email`
- `github_org`
- `repos_directory`
- `document_directories`
- `document_exclude_patterns`
- `document_extensions`
- `document_max_file_bytes`
- `slack_export_directory` — folder of per-week Slack summary files (see Slack handling).
- `slack_user_name`
- `output_directory` — stays `~/Documents/status-report/reports`; the existing repo
  directory continues to be where outputs land.

If the config file is missing, `collect.sh` exits with a clear error telling the user where
to create it.

The agent-gathered sources (Linear, Google Calendar) require no config keys — they use the
authenticated MCP connections. Calendar uses the user's accessible calendars, with the
event filter (below) doing the relevance work rather than a calendar allow-list. Slack uses
`slack_export_directory` + `slack_user_name` but is read directly by the agent, not a script.

## Run Flow

1. **Determine the period.**
   - Default: the previous complete calendar week, Monday–Sunday. For example, run on
     Tuesday 2026-06-30, the default range is 2026-06-22 to 2026-06-28.
   - Override: a month (`YYYY-MM`) or an explicit start/end date pair stated in the
     request.
2. **Run `scripts/collect.sh --start-date <start> --end-date <end>`** (a single command).
   It:
   - Reads `~/.config/status-report/config.json`.
   - Runs the github, git, and documents collectors into a working directory. (Slack is
     NOT run here — see step 5.)
   - Merges their outputs into `combined.json` (a `date_range` object plus one key per
     source).
   - Prints `WORK_DIR`, `COMBINED_JSON`, `START_DATE`, `END_DATE`, and `OUTPUT_STEM` to
     stdout.
   - Makes **no** LLM call. Per-collector failures log a warning and continue (same
     resilience as today). The merged JSON omits sources that produced nothing.
3. **Collect Linear via the Linear MCP.** SKILL.md specifies the exact, mechanical steps:
   - Resolve the current user (the authenticated Linear identity).
   - List issues assigned to that user, then bucket them into three groups matching the
     shape the old `linear.sh` produced:
     - **completed**: state is a completed/Done state and `updatedAt` is within range
     - **created**: `createdAt` is within range
     - **updated**: `updatedAt` is within range and not already in completed or created
   - For each issue keep: `id` (identifier), `title`, `description`, `url`, `state`,
     relevant timestamp(s), `labels`, `assignee`, `team`, `priority`.
   - If the Linear MCP is unavailable or unauthenticated, note it and proceed with the
     other sources.
4. **Collect Google Calendar via the Google Calendar MCP.** SKILL.md specifies the exact,
   mechanical steps:
   - List events on the user's calendars within the date range.
   - Keep only events that are meaningful work signal: the user's response is **not
     declined** AND the event has **at least one other attendee**. Drop all-day events and
     solo/focus blocks (no other attendees).
   - For each kept event keep: `title`, `start`, `end` (or duration), `attendees`
     (internal names), and whether the user was the **organizer**.
   - If the Google Calendar MCP is unavailable or unauthenticated, note it and proceed
     with the other sources.
5. **Read the week's Slack summary.** Slack summaries are one markdown file per week, named
   for the week's Monday: `<slack_export_directory>/slack-<START_DATE>.md`.
   - If the file exists, the agent reads it directly and uses the threads where
     `slack_user_name` participated (per the SLACK DATA HANDLING rules).
   - If the file is **missing** and `slack_export_directory` is configured, the agent asks
     the user before generating: wait while they add the file and re-run, or generate
     without Slack this time. No fabrication.
   - If `slack_export_directory` is not configured, skip Slack silently.
6. **Synthesize the report.** The agent reads `combined.json`, the Linear results, the
   Calendar results, and the Slack file (all held in context) and follows
   `reference/report-style.md`:
   - Group work into the established categories (Site Reliability Engineering, Code
     Reviews, Operations, Collaboration, etc.).
   - Business-value framing, concise bullets, sub-bullets sparingly, deduplicate related
     work (commits that became PRs = one bullet).
   - Apply the existing Slack and document handling rules (target-user attribution; do not
     cite document paths; no separate "Documents" section).
   - Apply the calendar handling rules: meetings enrich the **Collaboration** section as
     context (e.g., "led/attended working sessions on X"); summarize recurring meetings
     rather than listing each instance; no dedicated "Meetings" section.
   - **Hard rule:** synthesize only from collected data. Never fabricate activity. If no
     data was collected from any source, report the inability rather than invent content.
7. **Write output and preview.** Write the report to `output_directory` with a
   period-appropriate filename, then print a short preview:
   - Weekly → `status-report-YYYY-Www.md` (ISO week, e.g. `status-report-2026-W26.md`)
   - Monthly → `status-report-YYYY-MM.md`
   - Custom range → `status-report-<start>_to_<end>.md`
   - The report body keeps the current header format (title, period line, generated-at
     footer).

## Scripted vs. Agent-Driven

- **Scripts (deterministic, no reasoning):** date math, github, git, documents, JSON merge.
- **Agent (reasoning / MCP / file read):** Linear MCP collection, Google Calendar MCP
  collection, reading the week's Slack summary file, report synthesis, output filename
  selection, preview.

## Error Handling

- A collector failure inside `collect.sh` logs a warning and continues; the merge skips
  missing sources.
- Linear or Google Calendar MCP unavailable → the agent notes it and continues with
  whatever else collected.
- Week's Slack file missing (and Slack configured) → the agent asks the user before
  generating, rather than silently producing a Slack-less report.
- Zero data collected from all sources → the agent states it cannot produce a report
  rather than inventing one.

## Migration

1. Create `~/.claude/skills/status-report/` with `scripts/` and `reference/`.
2. Copy from the repo's **current working-tree versions** (the uncommitted `documents.py`
   and modified `common.sh` are the latest): `collectors/github.py`,
   `collectors/git-repos.sh`, `collectors/documents.py`, and `lib/common.sh` into the
   skill's `scripts/` (and `scripts/lib/`). `slack.py` is **not** carried over — the agent
   reads the week's Slack file directly.
3. Adapt `common.sh` / collector path assumptions for the new `scripts/` location and the
   `~/.config/status-report/config.json` config path.
4. Write `collect.sh` (the orchestration + merge, lifted from `generate.sh`'s collection
   and combine sections, with the `llm` synthesis section removed).
5. Write `reference/report-style.md` from the current `generate.sh` system prompt
   (the SLACK DATA HANDLING, DOCUMENT DATA HANDLING, OUTPUT REQUIREMENTS, STYLE EXAMPLE,
   and FORMAT blocks), plus a new CALENDAR DATA HANDLING block (meetings enrich
   Collaboration; summarize recurring meetings; no dedicated section).
6. Write `SKILL.md` with the run flow, the Linear MCP steps, the Google Calendar MCP steps,
   the Slack-file step (read `slack-<START_DATE>.md`; ask if missing), and the synthesis
   instructions (pointing at `reference/report-style.md`).
7. Move `config.json` to `~/.config/status-report/config.json`, dropping `llm_model`.
8. In the existing repo, **delete only the now-unused executable scripts**: `generate.sh`,
   `collectors/` (all), and `lib/`. Leave everything else untouched — `reports/`,
   `slack_summaries/`, `docs/`, and the repo's other data are not modified; the directory
   continues to be where outputs land. (`README.md` and `SLACK_PROMPT.md` are left in
   place; they are not scripts.)

## Testing

- Run `collect.sh` standalone for a known week and verify `combined.json` has the expected
  `date_range` plus per-source keys and shapes.
- Exercise the full skill for the previous week and eyeball the generated report against an
  existing report in `reports/` for style/section parity.
- Confirm graceful behavior when: config is missing, a single collector fails, and the
  Linear or Google Calendar MCP is unavailable.
- Verify the calendar filter keeps accepted multi-attendee meetings and drops all-day
  events, declined invites, and solo/focus blocks, and that recurring meetings are
  summarized rather than listed per-instance in the report.
- Verify the Slack behavior: when the week's `slack-<START_DATE>.md` exists the agent reads
  it; when it is missing the agent asks before generating (tested interactively, since
  subagents cannot prompt the user).
