# workbench — Design Spec

**Status:** Approved design (grilled 2026-10-09/10); not yet implemented.
**Date:** 2026-10-10
**Owner:** jacob@smithjs.org
**Glossary:** `local/lib/workbench/CONTEXT.md`

## Goal

One command that shows everything a piece of agent work produced (branches, worktrees, pull requests, across repos), lets me read each diff in hunk, edit the files in neovim, leave typed comments, and hand the whole batch back to the agent sessions that did the work, with my edits committed under my name and the agents told a human changed their output.

## Why

Two frictions in the current workflow. Finding what an agent session created is work in itself: 23 worktrees and 20 open PRs in infrastructure, 22 worktrees and 10 PRs in product-services, no tool that joins session to worktree to branch to PR. And correcting agent output means describing the change in conversation and waiting, when typing it in neovim would take ten seconds. Existing tools cover pieces (hunk, tuicr and review.nvim for comments on one repo; agent-of-empires and ccmanager for sessions to worktrees; gh-dash for PRs across repos) and nothing joins them, diffs a workset, or commits an in-review edit and tells the agent. Landscape notes: `~/.claude/jobs/b95bec8d/tmp/workflow-landscape.md` (will not survive; the summary is in this section).

## Non-goals

- A diff viewer. hunk is the reviewer; workbench wraps it.
- A web UI, or anything outside tmux and the terminal.
- Posting comments to GitHub. v1 keeps comments local between me and the agents; `submit --github` may mirror them later.
- Central repos as members (a shared checkout on its default branch collecting docs and ledgers). They are excluded from worksets for now; introducing branches and worktrees for them would disturb in-flight sessions. `kp-production-readiness` is explicitly excluded in config and reviewed the old way.
- Replacing `tmux-agent-sidebar` today. That plugin registers sessions through tmux hooks into its own state and is not working well; workbench may later absorb the parts of it worth keeping so it can be removed.
- Any harness other than Claude Code in v1. The adapter boundary exists so a second one is one new module.

## Decisions

Each line is a settled answer from the design session.

### Model

1. The unit of review is the **workset**: every branch, worktree and PR one piece of work produced, across repos, stacked or not. Sessions and stacks live inside it.
2. Membership is **declared and derived**. Agents and I declare members; derivation from configured repo roots and `gh pr list --author @me` fills gaps and surfaces **unclaimed** items for adopt, ignore or prune (prune only when merged or the remote branch is gone, with confirmation).
3. Members have a **role**: `work` (reviewed, locked) or `throwaway` (hidden by default, never locked).
4. A member's **diff base** is its PR base ref, else its declared base, else the repo's default branch. Stack order is derived from the PR base chain; a manifest `order` overrides it. A whole-stack node diffs the top against the bottom base.
5. A **harness** is the agent runtime. A **session pointer** named `<harness>-<id>.json` binds a session to a workset. The session-started hook creates it unbound and says so in the session's context; `workset use <name>` binds it to an existing workset; the session-ended hook closes it. Binding routes reviews and locks to the session and nothing else. (Revised 2026-10-22: the pointer was created bound to a default workset named `<harness>-<id>`, which was swept by `prune` when nothing in it was live and offered for `--move` on `use`. In practice every workset that mattered was named by hand, so the default workset, the named/unnamed distinction, the sweep and the `--move`/`--keep` flags were removed.)
6. State is plain files under `~/.local/state/workbench/`: `worksets/<name>.json`, `sessions/<harness>-<id>.json`, `inbox/<harness>-<id>/<review-id>.json`. Config is `~/.config/workbench/config.toml`, rcm-linked from `config/workbench/`, holding repo roots, worktree dirs, exclusions, GitHub user and enabled harnesses. Nothing in code names a path.

### Review window

7. `workbench open <workset>` creates or reuses a tmux session `wb-<workset>`, switches the client to it when run inside tmux and attaches otherwise. A new session, not a window in the current one: the layout wants the whole screen and two worksets under review never share a window list. `switch-client -l` is the way back; the sidebar shows bound sessions' state so the round trip is rarely needed.
8. The window has a **sidebar** pane (workset tree: members with PR state and stack position, whole-stack nodes, unclaimed items, bound sessions and their state) and a **hunk** pane. Selecting a member re-points hunk with `hunk session reload --session-path <pane cwd> --source <worktree> -- diff <base>...<branch>`; hunk runs with `--watch`.
9. Editing is hunk's `e`: my neovim on the real file in the member's worktree at the line; the diff refreshes on return. No patch editing, no embedded editor.
10. Opening a review **refuses on a dirty `work` worktree**, listing the files; `--allow-dirty` snapshots and excludes those changes from the review's commits.
11. **Comments** are hunk user notes. Type is a leading sigil: `?` question, `//` note, anything else change request. Each is anchored to repo, path, line range and the member's tip SHA at submit.

### Submit

12. Everything is **batched**: nothing reaches the agent until submit.
13. Submit, in order: for each touched `work` member, stage only the files I changed since open and make **one commit** authored by me with a message prompted once (default provided) and trailers `Workset:` and `Review:`; never amend or fixup an agent commit. Then write the review (comments, edit commits with repo, branch, SHA and files, optional overall message) to every bound session's inbox, release the lock, wake the agents.
14. `close` releases the lock without submitting and leaves comments in hunk's daemon.
15. The **lock** covers `work` members' worktrees while a review is open. It is enforced in the harness by hooks: Edit, Write and NotebookEdit are denied by path; Bash is denied when the command names a locked path or runs with cwd inside one and looks like a write (git commit, rebase, reset, checkout, merge, cherry-pick, stash, apply, push; redirection; `sed -i`, `rm`, `mv`, `cp`, `tee`). Reads pass. The deny message says who holds the lock. Because hooks are global, the lock reaches every session, not only bound ones. Context injected on prompt submit also tells the agent the lock exists, since the heuristic has false negatives.

### Agent side

16. **Claude Code first.** Hook entries in `claude/settings.json` call `workbench hook claude <event>`; the agent skill lives in `claude/skills/workbench-review/SKILL.md`. Both are already rcm-managed; a plugin can be extracted later.
17. The **adapter** turns Claude's hook JSON into generic events: session started or ended, about to write a path, about to run a command in a cwd, prompt submitted, turn ended. Lock, pointer and inbox logic sees only generic events.
18. **Curated membership**: members join a workset only through `workset add` or `workset adopt` and leave only through `rm`, `prune` or `delete`. The hooks never change membership. (Revised 2026-10-25: auto-recording, where the PreToolUse and PostToolUse hooks on Bash snapshotted a bound session's repos and recorded branches that moved or were checked out, inferred bases from ancestry, and read `git push -u` / `gh pr create` from the command, was removed. It put every branch a stack rebase touched into whichever workset the session happened to be bound to; worksets are meant to be curated by hand. Revised 2026-10-15 before that: parsing `git worktree add` from command text missed loops, variables and `~` paths.)
19. **Delivery**: a background watcher started by a hook (`asyncRewake`) waits on the session's inbox and exits with code 2 when a review arrives, which wakes Claude with "a review arrived for workset X, run `workbench inbox show`". `! workbench inbox show` always works by hand. A Claude Code mod with `$.prompt.submit` is the richer surface and can replace the watcher later.
20. **Review file**: JSON is canonical; `inbox show` renders markdown for humans and agents alike.
21. **Agent protocol** (the skill): read the review; `git log` the new commits in each worktree and treat them as canonical; address change requests in order; answer questions and notes with hunk agent comments beside the original plus a one-line conversation summary; never rewrite my commits unless the overall message explicitly says to squash; only then resume prior work.
22. **Replies** go into the live hunk session when there is one and are always appended to the review file in the inbox; `open` rehydrates them as agent comments.

### Implementation

23. TypeScript on Bun, the runtime hunk uses, so a hunk extension and OpenTUI are reachable later. Minimal dependencies: `util.parseArgs`, Bun's TOML loader, `bun test`.
24. Name `workbench`, alias `wb` (the brew formula `bench` is taken). Code at `local/lib/workbench/` (rcm → `~/.local/lib/workbench`), shim `local/bin/workbench`, config `config/workbench/config.toml`.
25. Build order: manifest, hooks and `workset` commands (discovery first); then the sidebar with hunk re-pointing; then submit, lock and inbox; then write-back and rehydration. Upgrade hunk from 0.19.0 to 0.23.0 and recheck `hunk session` before building on it.

## Alternatives considered

- **One PR stack as the unit**: too narrow; the spike alone spans a branch in infrastructure and docs in another repo.
- **Agent session as the unit**: sessions fork and multiply (today's fork shares one piece of work) and produce unrelated branches.
- **Derivation only**: cannot tell two concurrent pieces of my work apart. **Declaration only**: misses throwaways and hand-made branches.
- **tuicr** as reviewer: comments export and GitHub posting, but no editor hook and no agent write-back. **review.nvim**: editing is native, but no daemon for agents to write into.
- **Streaming comments** as made: a half-written review is noise to an agent that acts on everything it reads.
- **Amend or fixup agent commits**: rewrites SHAs that ledgers already name; the agent may be mid-rebase in the same worktree.
- **Lock everything / lock nothing**: blocking all tool use leaves the agent idle; a context note alone leaves `git commit -a` as a hole.
- **A window in the current tmux session**: cramped layout, mixed window lists.
- **Python with uv** (papersync's stack) or **Go**: fine, but a second runtime beside hunk's and no path to a hunk extension.

## Open questions

- Exact JSON shape of `hunk session comment list --type user --json` and `review --include-notes` in 0.23.0; probe before writing the normalizer.
- Whether hunk's `e` can be made to return to the same hunk after the diff reloads under `--watch`.
- How the sidebar should show a session's state without a harness API: start with pointer open/closed plus inbox read/unread, add turn state later via the Stop and UserPromptSubmit hooks.
- Which `tmux-agent-sidebar` behaviours are worth absorbing (to be listed when that migration starts).

### Observed in the end-to-end check (2026-10-10)

Run against a scratch repo (`main` plus a `feat` worktree), a workset `wb-e2e` in the real state dir and a scratch Claude Code session in tmux. Deviations from the decisions above:

- **Re-pointing (8):** hunk 0.23 refuses `session reload --source` across worktrees, so the pane restarts hunk for a member in another worktree; reload is used only within one worktree.
- **Comments (11, 14):** user notes live only in the hunk TUI and die with it, so the sidebar, `close` and `submit` snapshot them to `reviews/<workset>/notes/`; "comments kept in hunk's daemon" holds only while that hunk runs.
- **Diff (8):** the diff is the working tree against the merge base, not `<base>...<branch>`, so uncommitted edits (yours from `e`, or the agent's) show.
- **Skill path (16):** the skill lives at `agents/skills/workbench-review/SKILL.md` (linked to `~/.agents/skills`), not `claude/skills/`. Until `rcup` runs it is not installed; the scratch agent reported it could not find the skill and followed the arrival line instead (it still replied to all three comments correctly).
- **Session key (5):** the key is `claude-$CLAUDE_CODE_SESSION_ID`, read from the environment; `--session` is a fallback.
- **Editing (9):** `e` on a note's line opened neovim at line 1, not at the commented line. The diff did refresh on return and the notes survived.
- **Delivery (19):** worked. The Stop-hook watcher replaced the SessionStart one, and the agent woke within 5 s of submit ("Stop hook feedback").
- **Agent protocol (21):** without the skill the agent also replied to the note; the skill says to do so only when it changes something.
- **Submit from the shell (13), fixed:** `workbench submit` left the `wb-<workset>` window and its hunk running (only the sidebar's `s` killed it), and a later `open` adopted the live hunk pane without recording its session id, so it neither rehydrated replies nor showed new ones live, and the previous review's notes were still in that hunk. Fixed: `submitReview` itself kills the window after delivery and release (the sidebar keeps its key pause through a hook before the kill), and `open` on a window left up by any path finds the hunk pane by command, records its session id, snapshots its notes and rehydrates replies.
- **Notes carry over (13), fixed:** `reviews/<workset>/notes/` is keyed by member, not by review, and submit did not clear it, so the next review of the same workset would have delivered the previous review's comments again. Fixed: submit removes the directory after writing the inbox copies and the archive, before releasing the lock; close keeps it.
- **Session end (5), re-checked:** in the first check, after `/exit` the pointer stayed open and the SessionEnd hook did not appear to run. Re-checked in the final fix wave with `WORKBENCH_HOOK_DEBUG` set on a scratch interactive session in tmux (Claude Code 2.1.296): `/exit` delivered `SessionEnd` with `reason: "prompt_input_exit"`; the pointer was closed, its empty default workset deleted and no pid file or watcher was left. SessionEnd does fire on `/exit`. The same debug file also caught a short non-interactive session (cwd a temp dir, prompt `run: echo hi`) started under that tmux session before it was ready; its SessionEnd arrived with `reason: "other"`. Where it came from was not investigated. To be safe when a SessionEnd is missed or its kill fails, the watcher now also exits when its pointer is closed after it started, and logs each kill decision on stderr.
- **Sidebar width:** the 44-column sidebar cuts off member ids and the session line (`... replies 3…`).
- **Watchers:** a superseded watcher of another session (pid not in any pid file) was still running 23 minutes later; `wait` should have stopped it when its successor registered.
- **Wake window (19):** the asyncRewake watcher is bounded by the 2 h hook timeout, so a session idle for longer is not woken. The UserPromptSubmit hook now adds a line naming the unread reviews in that session's inbox, so the next prompt picks them up.
- **Reviewed set (13), fixed in the final review:** submit used to commit in every work member at submit time, including one recorded after open, and on whatever branch the worktree had checked out. Now open refuses a work worktree not on its member's branch, and submit commits and anchors comments only for members in the snapshot whose worktree is locked, re-checking the branch.

## Future directions

- A second harness adapter (Codex) once the generic events hold up.
- Branches and worktrees for central repos, so ledgers become members.
- Extraction of the Claude Code pieces into a plugin.
- `submit --github` mirroring comments as a PR review.
- A Claude Code mod replacing the inbox watcher and rendering review state in a pane.
