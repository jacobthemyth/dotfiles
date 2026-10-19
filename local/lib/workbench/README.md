# workbench

One command shows everything a piece of agent work produced (branches, worktrees, pull requests, across repos), lets you read each diff in hunk, edit the files in neovim, leave typed comments, and hand the batch back to the agent sessions that did the work.
Finding what a session created and correcting its output by describing changes in conversation are the two frictions it removes: your edits are committed under your name and the agents are told a human changed their output.

Glossary: [CONTEXT.md](CONTEXT.md). Design: [docs/superpowers/specs/2026-10-10-workbench-design.md](../../../docs/superpowers/specs/2026-10-10-workbench-design.md).

## Install

1. `RCRC=~/.dotfiles/rcrc rcup`: links `local/lib/workbench` to `~/.local/lib/workbench`, the shim `~/.local/bin/workbench`, `config/workbench/config.toml`, and the `workbench-review` skill (`agents/skills/workbench-review` to `~/.agents/skills/`, and `claude/skills/workbench-review` to `~/.claude/skills/`).
2. `brew bundle --global` (`~/.Brewfile` is `tag-mac/Brewfile`): installs `bun` and `hunk`. hunk must be 0.23 or later (`hunk --version`).
3. The hooks are already in `claude/settings.json`: `workbench hook claude` on PreToolUse (Edit, Write, NotebookEdit, Bash), PostToolUse (Bash), SessionStart, SessionEnd and UserPromptSubmit, and `workbench hook claude --watch` (asyncRewake) on SessionStart and Stop. New Claude sessions pick them up.

## Commands

| Command | What it does |
| --- | --- |
| `workbench config` | Print the loaded config as JSON. |
| `workbench workset list [--json]` | Overview: one row per workset with PR mix, dirty worktrees, session state and a suggested action (`review`, `prune`, `name`); unclaimed count per repo below. |
| `workbench workset show <name> \| create <name>` | Show or create a workset. |
| `workbench workset add <name> --repo <p> --branch <b> [--worktree <p>] [--base <ref>] [--order <n>] [--role work\|throwaway]` | Declare a member. |
| `workbench workset rm <name> <member-id>` | Remove a member. |
| `workbench workset use <name> [--session <key>]` | Bind a session to a workset (creates it if missing). |
| `workbench workset adopt <name> <id> [--role ...]` / `ignore <name> <id>` | Claim or ignore an unclaimed item from `scan`. |
| `workbench workset prune <id> [--yes]` | Remove a merged or gone branch and its worktree (dry run without `--yes`). |
| `workbench scan [--json]` | Derive branches, worktrees and PRs; list claimed, unclaimed and prunable. |
| `workbench open <workset> [--allow-dirty] [--no-attach]` | Open a review: lock the work worktrees, build the `wb-<workset>` tmux session. |
| `workbench submit <workset> [-m\|--message <m>]` | Commit your edits, deliver the review to bound sessions' inboxes, release the lock, kill the review window. |
| `workbench close <workset>` | Release the lock without submitting; notes are kept. Also clears a lock left behind by an `open` that failed part-way. |
| `workbench inbox list \| show [id] \| wait [--timeout <s>] [--session <key>]` | Read a session's inbox (`show` marks the review read). |
| `workbench reply --review <id> --comment <id> --text <t> [--session <key>]` | An agent's reply to one comment. |
| `workbench hook claude [--watch]` | Hook entry point (reads hook JSON on stdin). |
| `workbench sidebar <workset>` | The sidebar pane (started by `open`). |

Inside Claude Code the session key comes from `CLAUDE_CODE_SESSION_ID` (`claude-<id>`), or from `WORKBENCH_SESSION`; elsewhere pass `--session`.

## How members are recorded

A bound session's members are observed, not parsed. Before each Bash command the hook snapshots the local branches and worktrees of the command's repo, and of any repo whose path the command names (`git -C <repo>`, `cd <repo> && ...`). After the command it compares:

- A branch created or moved, or checked out in a new worktree, joins the workset with its worktree. Loops, variables, scripts and aliases make no difference.
- Commits on the default branch, detached worktrees, and switching an existing worktree to an existing branch record nothing.
- A worktree that went away is cleared from its member. A member whose branch and worktree are both gone leaves the workset.
- A member with no base gets an `inferred` base: the nearest other member its tip descends from. A declared or PR base is never replaced.
- Ignored ids are never recorded. A branch declared by path (`workset add --repo`) and observed by slug is one member.

`git push -u` and `gh pr create` are still read from the command and its output: they record an existing branch the session published, and the PR it opened. `workbench workset add` remains the explicit form for order, role and declared bases.

## Review flow

1. `workbench open <workset>`: the work worktrees are locked and the review window opens (sidebar left, hunk right). Each work member's worktree must have that member's branch checked out; `open` refuses otherwise, because submit commits on the branch the worktree has checked out. If `open` fails after taking the lock, `workbench close <workset>` releases it.
2. Select a member in the sidebar (`⏎`) to show its diff (working tree against the merge base with its diff base).
3. Comment in hunk with `c`, text, `Ctrl-S`: `? ` makes a question, `// ` a note, anything else a change request.
4. Edit with hunk's `e`: neovim on the real file; the diff refreshes when you quit.
5. Submit (`s` in the sidebar, or `workbench submit`): one commit per touched member, authored by you, with `Workset:` and `Review:` trailers; the review goes to every open bound session's inbox, the notes snapshots are cleared and the review window is killed.
6. The agent wakes, runs `workbench inbox show`, works through it and answers with `workbench reply`; the replies show in hunk the next time the window opens on that member.

Submit commits and delivers only for the members the review opened on. A member recorded after `open` is skipped (`skipping <id>: joined after open`), and so is one whose worktree has since switched branch. The review goes to sessions whose pointer is bound to the workset now; `workbench workset use` moves a session out of its previous workset.

The watcher that wakes an idle agent gives up after 2 hours (the hook timeout). A review that arrives later is not lost: the next prompt in that session adds a line saying how many unread reviews wait in its inbox.

When hunk restarts for a member (showing a member in another worktree, or reopening the window), your earlier comments on that member come back as agent comments by `you` (`you: <text>`). They are for reading only; submit delivers the snapshotted originals once.

## Sidebar keys

`j`/`k` move, `⏎` show the selection in hunk, `t` show throwaways, `s` submit (prompts for the message, then closes the window), `c` close (asks for yes; keeps the window), `q` quit.

Each bound session has a line: `<key>  open|closed  inbox: <n> unread  replies <r>/<c>`, where `c` counts the comments in that session's inbox reviews and `r` those with at least one reply.

## Walkthrough on a real workset

Run these by hand. Replace `spike` with your workset name and the ids with what `scan` prints.

```sh
workbench scan                                  # find the spike's branches under "unclaimed"
workbench workset adopt spike <repo-slug>#<branch>   # once per branch; creates the workset
workbench workset show spike
```

In the Claude session that did the work (or a new one in the member's worktree), ask it to run `workbench workset use spike`, then check `~/.local/state/workbench/sessions/claude-<id>.json` says `"workset": "spike"`.

```sh
workbench open spike        # refuses on uncommitted changes; --allow-dirty to proceed anyway
```

In hunk: leave one `? question`, one `// note` and one plain change request (`c`, text, `Ctrl-S`); press `e` on a changed line, edit, `:wq`. Then press `s` in the sidebar and give a message, or from another shell:

```sh
workbench submit spike -m "first review"
git -C <worktree> log -1 --format='%an%n%B'          # you, with Workset: and Review: trailers
ls ~/.local/state/workbench/inbox/claude-<id>/        # the review file
```

Within a few seconds the agent shows "Stop hook feedback" and runs `workbench inbox show`; it commits the change request and runs `workbench reply` for each comment. Then:

```sh
workbench open spike    # replies appear as agent comments on the commented lines (toggle agent notes in hunk if hidden)
workbench close spike   # release the lock when done reading
```

## Known limitations

- Observation sees only the command's own repo and repos whose paths appear in its text. A script that changes a repo it never names is missed. Another session moving refs in the same repo during the same command is attributed to both sessions.
- The snapshot costs a few git calls per Bash command: about 35 ms in a repo with 100 branches and 35 worktrees, plus about 150 ms when refs changed and bases are recomputed.

- hunk 0.23 refuses `session reload --source` across worktrees, so showing a member in another worktree restarts hunk in the pane.
- hunk user notes live only in the TUI's memory and die with it; the sidebar, `close` and `submit` snapshot them to `~/.local/state/workbench/reviews/<workset>/notes/`. Submit clears that directory once the review is delivered; close keeps it.
- The lock is enforced by hooks. The Bash heuristic (write-like commands naming or running in a locked path) has false negatives; the prompt-submit context tells the agent about the lock as a backstop.
- No GitHub posting: comments stay between you and the agents.
- The sidebar is 44 columns wide, so long member ids and session lines are cut off.
