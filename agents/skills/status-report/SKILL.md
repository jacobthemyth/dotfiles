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
`OUTPUT_STEM`. Then read the `COMBINED_JSON` file — it holds the github, git, and documents
data plus the `date_range`. If the script exits non-zero because config is missing, tell the
user to create `~/.config/status-report/config.json` and stop.

## 3. Collect Linear via MCP

Using `START_DATE`/`END_DATE` from step 2:

1. Resolve the current Linear user (the authenticated identity / "me").
2. **Gather candidates.** List issues assigned to that user, using the list filters as a
   coarse net only (e.g. `updatedAt` from `START_DATE`, plus `createdAt` in range).
3. **Confirm each candidate with immutable timestamps.** The list response does not carry
   them, so fetch the issue (`get_issue`) and read `completedAt`, `canceledAt`, `startedAt`,
   `createdAt`, and `stateHistory`. Then bucket:
   - **completed**: `completedAt` is within range.
   - **created**: `createdAt` is within range.
   - **in progress**: any `stateHistory` entry whose state `type` is `started` *overlaps* the
     range — i.e. its `startedAt` <= `END_DATE` AND (`endedAt` is null OR `endedAt` >=
     `START_DATE`) — and it is not already in a bucket above. Use **overlap, not containment**:
     an issue worked continuously across the whole week has no transition inside the week, and
     is exactly the ongoing work most worth reporting. Do not rely on the top-level
     `startedAt` field; it can be `null` even when `stateHistory` shows started states, so
     `stateHistory` is authoritative.
   - **canceled**: `canceledAt` is within range. Report as backlog hygiene, never as delivery.
   - **touched (low confidence)**: `updatedAt` is in range but none of the above are. Do NOT
     credit these as work on their own — only include one if GitHub, git, or Slack
     independently corroborates activity that week, and describe it as in-flight, not done.

   **Why this matters:** `updatedAt` records only the *latest* touch, so it is not evidence
   that work happened in the window. A grooming pass weeks later rewrites `updatedAt` on
   every issue it touches, which both drags long-finished issues into the week and pushes
   genuinely active issues out of it. `completedAt`, `createdAt`, `canceledAt`, and
   `stateHistory` entries are immutable — prefer them always.

   If `completedAt` is genuinely unavailable for an issue, you may fall back to
   completed-state + `updatedAt` in range, but say in your summary to the user that you did.
4. For each issue keep: identifier, title, description, url, state, the deciding timestamp
   (and which field it came from), labels, assignee, team, priority.

If the Linear MCP is unavailable or unauthenticated, note it to the user and continue.

## 4. Collect Google Calendar via MCP

Using `START_DATE`/`END_DATE`:

1. List events on the user's calendars within the range.
2. Keep an event ONLY if the user's response is **not declined** AND it has **at least one
   other attendee**. Drop all-day events and solo/focus blocks (no other attendees).
3. For each kept event keep: title, start, end (or duration), other attendees, and whether
   the user was the organizer.

If the Google Calendar MCP is unavailable or unauthenticated, note it to the user and continue.

## 5. Read the week's Slack summary

Slack summaries are one markdown file per week, named for the week's Monday:
`<slack_export_directory>/slack-<START_DATE>.md` (e.g. `slack-2026-06-22.md`). Read
`slack_export_directory` from config (`jq -r '.slack_export_directory' ~/.config/status-report/config.json`,
expand a leading `~`).

- If the file exists, read it directly. Use the threads where the user (the configured
  `slack_user_name`) participated, following the SLACK DATA HANDLING rules in
  `report-style.md`.
- If the file is **missing** (and `slack_export_directory` is configured), the user may have
  forgotten to add it. ASK them before generating: offer to (a) wait while they add
  `slack-<START_DATE>.md` and re-run, or (b) generate without Slack this time. Do not
  fabricate Slack content.
  - To help with (a), offer them the ready-to-send prompt in
    `~/.claude/skills/status-report/reference/slack-summary-prompt.md`. Read it, substitute
    `<SLACK_USER_NAME>` (from config `slack_user_name`), `<START_DATE>`, and `<END_DATE>`, and
    hand them the filled-in text to run in a Slack-connected session. You cannot read Slack
    yourself.
- If `slack_export_directory` is not configured at all, skip Slack silently.

## 6. Synthesize the report

Read `~/.claude/skills/status-report/reference/report-style.md` and follow it exactly.
Combine the `COMBINED_JSON` contents with the Linear, Calendar, and Slack material you gathered.

**Hard rule:** use only collected data. Never fabricate activity. If every source came back
empty, tell the user you cannot produce a report rather than inventing content.

## 7. Write the report and preview

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
