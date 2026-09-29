# Status Report: Agent Sessions Source — Design

**Date:** 2026-09-29
**Status:** Approved design; not yet implemented.

## Overview

Add the user's local Claude Code and Codex sessions as a status-report source, make Slack
optional, and restore the skill's discovery by Claude Code. Then backfill the missing
weekly reports.

**Why:** Slack summaries were the main source of non-code context (discussions,
investigations, decisions). The user no longer has access to Slack through a bot or the
Slack connector (they are a multi-channel guest). Most of their working time is spent in
Claude Code and Codex sessions, so those sessions are the best replacement.

**What sessions contribute:** non-code work (investigations, incident analysis, design,
planning, review) that never becomes a commit or PR. A session that led to a PR or commit
only adds context to that item's bullet. It never gets a bullet of its own.

## Findings that shaped the design

- **Discovery bug.** Commit `c3fcd11` ("Move skills") moved the skill from
  `claude/skills/` to `agents/skills/`. rcm links `agents/skills/*` to `~/.agents/skills/`,
  but Claude Code reads from `~/.claude/skills/`. Other moved skills were linked into
  `~/.claude/skills/` by hand; `status-report` was not.
- **Other sources checked and rejected.** Zoom (meetings and My Notes) returned zero
  records. Notion meeting notes had 2 in 9 weeks. Drive has no Gemini meeting notes.
  Gmail, Drive and incident.io were not requested. All of these are out of scope.
- **Session volume and noise** (9 gap weeks, about 4.5 GB of JSONL):
  - Claude: about 420 top-level sessions and about 5,400 subagent transcripts.
    `entrypoint` is `cli` for interactive sessions and `sdk-cli` for headless and probe
    runs.
  - Codex: 855 files, of which about 150 are user-started (`source` `cli`/`vscode`,
    `thread_source: user`). 631 are `guardian_review` or `subagent` threads. 53 are
    `codex_exec` runs, started by Claude-driven skills such as `codex:adversarial-review`. 10 have
    originator `Claude Code`.
  - Personal projects run next to work repos, so work and personal sessions are mixed.

## Architecture

```
collect.sh ──► sessions.py --start-date --end-date [--claude-dir] [--codex-dir]
                            --exclude-paths ... --repos-dir ... --output sessions.json
                     │
                     ▼
            combined.json { date_range, github, git, documents, sessions }
                     │
       agent (SKILL.md) ── Linear, Calendar (MCP); Slack file if present
                     │
                     ├─ match sessions ↔ PRs/commits by repo + branch/time
                     ├─ deep-read up to 3 unmatched substantial groups
                     │     └─► sessions.py --expand <session_id>
                     ▼
               synthesize report (report-style.md)
```

This is **option 3** of the three considered: scripted summaries plus a limited number of
deep reads. The rejected options were summaries only (can miss what a long
investigation concluded) and a subagent reading every session (highest cost, results
vary between runs).

### Files touched

All paths are under `~/.dotfiles/agents/skills/status-report/` unless noted.

| File | Change |
|---|---|
| `scripts/sessions.py` | New. Collect mode and expand mode. Python standard library only. |
| `scripts/test_sessions.py` | New. unittest, synthetic sanitized fixtures. |
| `scripts/collect.sh` | New collector block; `sessions` added to the merge loop; header comment updated. |
| `SKILL.md` | New "Analyze agent sessions" step; Slack step changed; description lists sessions. |
| `reference/report-style.md` | New SESSION DATA HANDLING section; INPUT line updated. |
| `~/.dotfiles/config/status-report/config.example.json` | New `session_exclude_paths` key with placeholder values. |
| `~/.claude/skills/status-report` | New symlink → `../../.agents/skills/status-report`. |

No `rcup` run is needed for new files. `SYMLINK_DIRS` makes
`~/.agents/skills/status-report` a symlink to the whole directory, so new files appear
immediately. (This replaces the older file-by-file linking under `claude/skills/`.)

## `sessions.py`: collect mode

### Inputs

- `--start-date`, `--end-date` (YYYY-MM-DD, inclusive, local time).
- `--claude-dir` (default `~/.claude/projects`), `--codex-dir` (default
  `~/.codex/sessions`). The Codex session index is read from `<codex-dir>/../session_index.jsonl`.
  These are CLI flags for tests, not config keys.
- `--exclude-paths`: comma-separated path prefixes.
- `--repos-dir`: used to derive `repo`.
- `--output`: path of the JSON file to write.

### File selection

Only files whose `mtime` is on or after the start date are opened. Files are read line by
line (streaming); a file is never loaded whole.

### Qualifying sessions

**Claude** (`<claude-dir>/*/*.jsonl`; any path containing `/subagents/` is skipped):
- At least one record has `entrypoint == "cli"`. Sessions that only have `sdk-cli` are
  dropped.
- **Typed prompt:** a record with `type == "user"`, `isMeta` not true, `isSidechain` not
  true, whose `message.content` is a string (or an array containing `text` blocks and no
  `tool_result` blocks). It does not count if the text starts with
  `<local-command-stdout>` or `<local-command-caveat>`, or consists only of
  `<system-reminder>` content. A `<command-name>/foo</command-name>` record counts as the
  prompt `/foo <command-args>`.
- **Assistant text:** `type == "assistant"` records' `text` content blocks.
- **Files touched:** `file_path` from `tool_use` blocks named `Edit`, `Write` or
  `NotebookEdit`.

**Codex** (`<codex-dir>/**/*.jsonl`):
- The first record is `session_meta`. Keep the session only if `payload.source` is `cli`
  or `vscode`. Drop object values (`subagent`/guardian threads) and `exec`. The user never
  runs `codex exec` by hand: `exec` sessions come from Claude-driven skills such as
  `codex:adversarial-review`, and the parent Claude session already covers them.
- Also drop the session if `payload.originator == "Claude Code"`, or if its `thread_name`
  in `session_index.jsonl` starts with `Codex Companion Task`.
- **Typed prompt:** `type == "event_msg"` with `payload.type == "user_message"`; the text
  is `payload.message`.
- **Assistant text:** `event_msg` with `payload.type == "agent_message"`.
- **Files touched:** paths parsed from `apply_patch` tool calls (`*** Update File:`,
  `*** Add File:` lines).
- **cwd and branch:** from `session_meta.payload.cwd` and git metadata if present,
  otherwise from `turn_context` records.

**Both tools:**
- **Time bucketing:** record timestamps (UTC) are converted to local time. A record is
  in range if it falls between START 00:00:00 and END 23:59:59. A session qualifies only
  if it has at least one in-range typed prompt. Only in-range records contribute to the
  entry, so a session that spans two weeks appears in both, each time with that week's
  content.
- **Denylist:** drop the session if its `cwd`, after expanding `~` and resolving the
  path, equals an excluded prefix or is under it (compare path components, not
  substrings: `~/Code/beads` must not exclude `~/Code/beadsmith`). `collect.sh` always
  adds `output_directory` and the skill directory to the list.

### Output

```json
{
  "date_range": {"start": "2026-09-14", "end": "2026-09-20"},
  "skipped_lines": 0,
  "size_trimmed": false,
  "sessions": [
    {
      "tool": "claude",
      "session_id": "…",
      "cwd": "~/Code/acme/api-service/.claude/worktrees/add-retries",
      "repo": "acme/api-service",
      "worktree": "add-retries",
      "branches": ["devuser/add-retries"],
      "first_prompt_at": "2026-09-15T10:02:00-04:00",
      "last_prompt_at": "2026-09-15T16:40:00-04:00",
      "active_minutes": 185,
      "prompt_count": 23,
      "prompts": ["…"],
      "prompts_truncated": true,
      "final_assistant_message": "…",
      "files_touched": ["…"]
    }
  ]
}
```

- **`cwd`:** shown with `~` in place of the home directory.
- **`repo`:** `cwd` relative to `repos_directory`, with any `/.claude/worktrees/<name>`
  suffix removed (the name goes into `worktree`). `null` if `cwd` is outside
  `repos_directory`.
- **`branches`:** the distinct branch values from in-range records, excluding `HEAD`.
- **`active_minutes`:** the sum of gaps between consecutive in-range records (any type),
  where any gap over 30 minutes counts as 0. Rounded to whole minutes.
- **`prompt_count`:** the number of in-range typed prompts.
- **`prompts`:** the first 5 and last 3 in-range typed prompts (all of them if 8 or
  fewer), each cut to 300 characters. `prompts_truncated` is true if any prompt was cut
  or left out.
- **`final_assistant_message`:** the last in-range assistant text, cut to 1500
  characters.
- **`files_touched`:** distinct paths, `~`-abbreviated, at most 20.
- **Entry order:** by `first_prompt_at`.
- **Size cap:** if the serialized output is over 200 KB, trim every entry's `prompts` to
  the first 3 and last 1; if still over, to the first prompt only; then set
  `size_trimmed: true`. Entries are never dropped.

### Errors

- A line that is not valid JSON, or a record missing the expected fields, is skipped and
  counted in `skipped_lines`.
- A missing `--claude-dir` or `--codex-dir` contributes zero sessions and is not an error.
- Exit non-zero only for bad arguments or an unwritable output file.

## `sessions.py`: expand mode

`sessions.py --expand <session_id> [--start-date --end-date] [--claude-dir] [--codex-dir]`

- Finds the session file by ID (Claude: the filename stem; Codex: `session_meta.payload.id`
  or the ID at the end of the filename).
- Prints a plain-text transcript: a header (tool, cwd, branches, time span), then, in
  order, each typed prompt as `USER [HH:MM]:` and each assistant text as `ASSISTANT:`.
  Tool calls and tool output are left out.
- With `--start-date`/`--end-date`, only in-range records are printed.
- An unknown ID exits non-zero with `session not found: <id>`.

## `collect.sh` changes

- New "Agent sessions" block after Documents. It passes `session_exclude_paths` from
  config (each `~`-expanded) plus `output_directory` and `$SCRIPT_DIR`, and
  `repos_directory`. On failure, log `Sessions collector failed` and continue, like the
  other collectors.
- Add `sessions` to the merge loop (`for src in github git documents sessions`).
- Update the header comment so it no longer says Slack is collected there.

## SKILL.md changes

**Slack step:** if `slack-<START_DATE>.md` exists, read it as before. If it is missing,
**do not ask.** Continue without Slack, and include this line in the end summary to the
user: `No Slack summary for this week (slack-<START_DATE>.md); add one and re-run to
include it.` Keep `reference/slack-summary-prompt.md`, but do not offer it automatically.
If `slack_export_directory` is not configured, skip Slack silently (unchanged).

**New step: "Analyze agent sessions"** (after Calendar, before synthesis):

1. **Match.** For each entry in `combined.json.sessions`, look for a GitHub PR or local
   commit in the same `repo` whose branch is in the entry's `branches`, or whose
   timestamp falls between `first_prompt_at` and `last_prompt_at`. A matched session is
   context for that PR's or commit's bullet only.
2. **Group the unmatched sessions** by `repo`, or by `cwd` when `repo` is null. Sessions
   on the same topic count as one piece of work.
3. **Deep read.** A group qualifies if its total `active_minutes` is at least 45 or its
   total `prompt_count` is at least 10, and its summaries do not make clear what it
   concluded. Pick at most 3 qualifying groups per report, largest `active_minutes`
   first. For each, run `sessions.py --expand <session_id> --start-date … --end-date …`
   on the group's session with the most `active_minutes`, and read the transcript.
4. **Discard.** Drop unmatched sessions whose `cwd` is outside `repos_directory` (for
   example `~` or `~/Desktop`) unless their prompts are clearly about work for the
   client. Drop tooling and yak-shaving sessions (editor or agent setup, skill writing,
   dotfiles-style work), even inside a work repo, unless the result was for the team.
5. **Report back.** In the end summary to the user, list which sessions were deep-read
   and how many were dropped.

Also update the frontmatter `description` and the intro line to include Claude Code and
Codex sessions.

## report-style.md changes

Update the INPUT line to include agent sessions, and add this section:

```markdown
## SESSION DATA HANDLING
- `sessions[]` are the user's Claude Code and Codex sessions. `prompts` are what the user
  asked for; `final_assistant_message` is what the session concluded. Deep-read
  transcripts give fuller detail for a few sessions.
- Sessions matched to a PR or commit are context only: use them to explain why or what
  resulted, inside that item's bullet.
- Credit an unmatched session as work done only when it shows an outcome: an analysis
  finished, a root cause found, a design decided, a review delivered. Leave out
  exploratory or abandoned sessions, or describe them as in flight ("Began
  investigating…").
- Describe the work and its business value, never the tool. Do not write "used Claude"
  or "used Codex".
- Do not cite session IDs, paths or prompt text, and do not add a separate "Sessions" or
  "AI" section. Put session work into the existing sections.
- Prompts can contain secrets, customer or patient data, or colleagues' messages. Never
  quote them.
- When a Linear issue or document covers the same work, use that source's framing, and
  use the session only for what happened this week.
```

## Config

Add this to `config.example.json` (placeholder values, since the repo is public):

```json
"session_exclude_paths": ["~/.dotfiles", "~/Code/personal", "/private/tmp", "/tmp"]
```

The user's real config lists their own personal project paths plus `/private/tmp` and
`/tmp`. `~` and `~/Desktop` are deliberately **not** excluded; the agent judges those
sessions (SKILL.md step 4). If the key is missing, the collector still runs, and only the
two automatic exclusions apply.

## Testing

`scripts/test_sessions.py` (unittest, the same style as `test_github.py`). Fixtures are
small synthetic JSONL files built in a temp dir, using only sanitized names (`acme/…`,
`devuser`).

- Claude filters: `sdk-cli`-only session dropped; `subagents/` path skipped; tool-result,
  meta, sidechain, local-command and system-reminder-only records not counted as
  prompts; slash commands counted as `/name args`.
- Codex filters: object `source` (subagent/guardian) dropped; `exec` source dropped;
  originator `Claude Code` dropped; `Codex Companion Task` thread name dropped; user `cli`
  and `vscode` sessions kept.
- Bucketing: a session crossing Sunday 23:59 into Monday (local time) splits between the
  two weeks; a session with no in-range prompts is dropped.
- Denylist: prefix match on path components (`~/Code/beads` does not exclude
  `~/Code/beadsmith`); automatic exclusions applied.
- Derived fields: worktree suffix removed for `repo`; `branches` excludes `HEAD`;
  `active_minutes` ignores gaps over 30 minutes; prompt selection is first 5 and last 3;
  truncation lengths.
- Size cap: trims prompts in both stages and never drops entries.
- Robustness: invalid JSON line skipped and counted; missing source dir gives zero
  sessions.
- Expand: output contains prompts and assistant text only; date filtering applied;
  unknown ID exits non-zero.

**Live check** (not automated): run `collect.sh --start-date 2026-09-14 --end-date
2026-09-20` and inspect `sessions.json`. Check that the entry count is reasonable, no
excluded paths appear, the size is under the cap, and the week's known work repos appear.

## Backfill (once, after implementation)

- Nine weekly reports, oldest first, each generated with `--start-date <Mon> --end-date
  <Sun>`: 2026-07-27 through the week of 2026-09-21. Oldest first lets multi-week work
  read as continuing.
- Output files follow the existing `status-report-YYYY-MM-DD_to_YYYY-MM-DD.md` pattern.
- Stop after the first report (2026-07-27 to 2026-08-02) for the user to review before
  generating the rest.

## Out of scope

Zoom, Notion meeting notes, Gmail, Drive and incident.io as sources; caching session
summaries between runs; changing the report's section structure.
