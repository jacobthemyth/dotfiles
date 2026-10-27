# workbench: the window outlives the review, and threads can be resolved — Design Spec

**Status:** Implemented 2026-10-26 on branch `workbench-watching` (63fc84d..HEAD).
**Date:** 2026-10-26
**Owner:** jacob@smithjs.org
**Glossary:** `local/lib/workbench/CONTEXT.md`
**Builds on:** `docs/superpowers/specs/2026-10-10-workbench-design.md`

## Goal

After I submit a review, I can keep watching the agent's replies and follow-up commits land beside the code without locking its worktrees, and start the next review round from the same window when I choose. A thread I am done with can be closed with a `/resolve` reply so it stops coming back, and a comment I delete in hunk before submitting stays deleted.

## Why

Three defects in the current flow, all with one cause: workbench treats the review window and the review as one thing, and never reads anything back from hunk except the user notes it merges in.

1. Submit kills the review window. The agent's replies then land only in files, because a reply is shown live only when an open review has that member on screen. The only reader is a fresh `workbench open`, which starts a new review and locks every work worktree, and the lock denies the agent's edits mid-task.
2. Replies are shown once per hunk session id, and every `open` starts a new hunk session, so every archived reply for a member is re-shown on every open. The live cinf-794 session carries six replies across three threads from several rounds. Deleting a reply note in hunk clears only that session's memory.
3. The notes snapshot merges hunk's live user notes into the saved file and never removes one, so a note deleted in hunk before submit is still delivered.

## Non-goals

- Unresolving a thread. A follow-up is a new comment on the line.
- Resolution from the agent's side (`reply --resolve`, or a done reply closing a change request). The reviewer closes threads.
- Posting to GitHub, as before.
- Any change to how members are curated.
- Killing the tmux window from the sidebar. `q` quits the sidebar only, as today; the window's lifetime is the user's.

## Decisions

### Window and review

1. **The review file is split in two.** `windows/<ws>.json` holds what the tmux window needs: hunk pane id, hunk session id, pane cwd, current member id, and the two per-session maps in decisions 12 and 15. It exists while the `wb-<ws>` tmux session does; `open` rebuilds it when it is missing or names a dead pane. `reviews/<ws>.json` keeps only the review: id, workset, opened, snapshot, locked. It exists while a review is open. The lock file is unchanged, so the hook does not change. `reconcileIds` re-keys the window's current member and the review's snapshot as it does today.
2. **Two modes.** A window with no review is **watching**: nothing is locked, hunk runs with `--watch` so the agent's commits land in the diff, replies stream in live (decision 17), and comments typed in hunk are kept as the pending notes of the next review. A window with a review is **reviewing**, which is today's behaviour.
3. **`workbench open <ws>`** builds or repairs the window and enters watching. `open --review` also starts a review, for the shell habit. `--allow-dirty` applies to the review start only. `--no-attach` is unchanged.
4. **Sidebar `r` starts a review**: the dirty check, the branch check, the snapshot, the lock and a new review id, exactly `openReview`'s review half today. Pending notes become the review's notes without being touched: the notes directory is keyed by workset and member, not review id, so nothing moves.
5. **Submit returns the window to watching.** It delivers, archives, clears the notes directory and releases the lock as today, then stops: the window is not killed, hunk is not restarted, the window file keeps its hunk session id. `workbench submit` from the shell behaves the same. The sidebar's "press any key" pause goes, since the pane does not disappear under the user.
6. **Close returns the window to watching**: the review file and the lock go and notes are kept, as today; close already left the window up, so the only change is the mode the sidebar shows. The close confirmation text drops the sentence about comments living only in hunk's memory, since the sidebar now snapshots them continuously (decision 11).
7. **Sidebar.** The header reads `<ws>  watching` or `<ws>  reviewing <review id>`. The key line is `j/k move  ⏎ show  t throwaways  r review  s submit  c close (asks for yes)  q quit`. `r` while reviewing sets the status to "a review is already open"; `s` while watching sets it to "no review to submit; press r". `c` while watching sets "nothing to close". Errors from `r` (dirty worktrees, wrong branch checked out) become the status line.
8. **Refusals keyed on the window.** `workset rename`, `prune` and `delete` are refused while a window exists for the workset, not only while a review is open, because the window file and the tmux session are keyed by name. The message says "review window open; quit it first". A `prune` with no name skips a workset that has a window and says so.
9. **The hook is unchanged.** Lock lines on prompt submit, denies on write and command, and the inbox watcher all read the same files they read today.

### Edits while watching

10. **Edits are refused without a review.** hunk is started with `EDITOR` set to `workbench edit-guard <ws> -- <real editor command>`, where the real editor is the user's `$EDITOR` (or `$VISUAL`) at open time, defaulting to `nvim`. The guard checks for `reviews/<ws>.json`: with it, it execs the real editor with the arguments hunk passed; without it, it prints "lock first: press r in the sidebar" to the pane, waits for a key and exits 0. The reason: an edit made while watching would count as pre-existing dirt at the next `r`, so `r` would refuse on a dirty worktree, and with `--allow-dirty` the submit would silently leave the edit out of its commit.

### Notes, deletions and resolution

11. **Snapshot cadence.** Notes are snapshotted where they are today (member switch, review start, close, submit) and also on every sidebar refresh tick (five seconds) for the current member. The sidebar is the one long-lived process, so the extra `hunk session comment list` call lives there; nothing else polls.
12. **Deletions are tracked.** The window file records, per member, the set of note ids known to be live in the current hunk session: the user's original notes and the ids of any `you:` proxy notes re-shown after a hunk restart (each mapped to the original's id). A snapshot lists hunk's notes with `--type all`, so a note whose file left the diff under `--watch` is not mistaken for a deleted one. An id that was live at the previous snapshot and is absent now is a deletion: the note leaves the snapshot file, and a deleted proxy removes its original. The set is reset whenever the hunk session id changes, so a fresh hunk, which holds none of the earlier notes, deletes nothing. To know proxy ids, `hunk.addAgentComment` returns the id hunk's `--json` output carries, instead of a boolean.
13. **Threaded user replies are read.** `normaliseNotes` today keeps top-level user notes only. The snapshot now also collects user notes with a `parentId` and hands them to the resolution step; they are still never delivered as comments.
14. **`/resolve` closes a thread.** A threaded user reply whose body starts with `/resolve` resolves the thread its parent belongs to. Trailing text is the closing note. The parent is found through the thread map (decision 15). Resolution does, in order: write `resolved: { at, by: "you", text }` on the comment in the archive and in every inbox copy that has it (via `updateReviewFile`, so concurrent agent replies are not lost); queue the comment id for delivery (decision 18); remove the thread's shown notes and the `/resolve` reply from hunk with `hunk session comment rm`, so the screen agrees with the files. A `/resolve` under one of the user's own un-submitted notes drops that note from the snapshot and removes both from hunk, the same as deleting it. Any other threaded user reply is ignored and left on screen, as today. A `/resolve` whose parent is not in the thread map (a note workbench did not add and does not recognise) is left on screen and the status line says "cannot resolve: unknown thread".
15. **The thread map.** The window file records, per hunk session, note id to archived comment id for every note workbench adds: reply notes (`rehydrateReplies` and `addReply`) and `you:` proxies (`reshowOwnNotes`). A reply threaded under the user's original note needs no entry, because the parent id is the comment id itself. The map resets with the hunk session id.
16. **Resolved threads stay closed.** `rehydrateReplies` skips a comment with `resolved`. `addReply` to a resolved comment still appends the reply to the files, so a late agent is not lost, and does not show it in hunk. `workbench reply` prints "(thread resolved)" in that case. `inbox show` renders a resolved comment as one line, `- ~~resolved~~ **question** path:lines (id) — text — closed: <closing text>`, with its replies omitted. The sidebar session line becomes `<key>  open|closed  inbox: <n> unread  threads <open> open / <total>`, where open counts comments in that session's inbox reviews without `resolved`.

### Replies and delivery

17. **Replies show live in watching mode.** `addReply` shows a reply when the window file's current member is the comment's member and its hunk session is alive; this is today's check moved from the review file to the window file. `rehydrateReplies` runs on member switch and window repair as today, reading the window's hunk session id.
18. **The review file gains `resolved: string[]`**: the comment ids resolved since the previous submit on this workset, drained from a per-workset queue file `reviews/<ws>/resolved-pending.json` at submit. Ids may belong to earlier reviews. `inbox show` lists them under a `## Resolved` heading, each with its review id, path and the original text. The agent skill gets one rule: a thread under Resolved needs no reply and no work, and a question the agent answered that then shows there is closed.

### Docs

19. **Glossary.** CONTEXT.md gains **Window** (the tmux session `wb-<workset>` with its sidebar and reviewer, which outlives any one review; replaces the Review window entry), **Watching** (a window with no review open: unlocked, following the agent's commits and replies, collecting pending comments) and **Resolution** (the reviewer closing a thread with a `/resolve` reply; a resolved thread is not re-shown and needs nothing from the agent). **Submit** and **Close** now end "and return the window to watching". **Reviewing** is named as the other mode under **Review**.
20. **README.** The review flow, the sidebar keys, the commands table (`open --review`, `edit-guard` as an internal command) and the known limitations (the hunk-memory note is replaced by the snapshot-tick note) change to match. The agent skill gains the Resolved rule.

### Testing

21. Existing dry-run fixtures (`WORKBENCH_DRY_RUN_HUNK_NOTES`, `WORKBENCH_DRY_RUN_HUNK_SESSIONS`) carry most of it:
   - review-open tests: `open` yields a window and no review; `open --review` and the review-start function yield both; `r` on dirty refuses and leaves the window; the window file is rebuilt when its pane is dead.
   - submit tests: the window survives submit; the lock and review go; the hunk session id is unchanged; `resolved` is drained into the review file and the queue emptied.
   - a pure deletion-detection test over two consecutive note lists with a live set, including a proxy whose deletion removes its original and a session-id change that deletes nothing.
   - a pure `/resolve` parser test: bare, with text, non-resolve threaded reply ignored, unknown parent reported.
   - reply tests: `addReply` on a resolved comment appends and does not show; `rehydrateReplies` skips resolved; the thread map is written on show.
   - render test for the resolved line and the Resolved section; sidebar-model test for the header modes and the threads count.
   - edit-guard test: refuses without a review file, execs with one (dry run records the argv).

## Alternatives considered

- **Replies as a transcript plus a notification, no window change.** Cheapest, but reads answers away from the diff and still relocks to see them in place. Rejected as the fix, kept as a possible later `workbench review show`.
- **Lock on demand instead of on open.** Would have let a stray `c` in hunk take the lock, and snapshots against a tree the agent is still moving. Rejected in favour of an explicit `r`.
- **Deleting the reply note in hunk resolves the thread.** The most natural gesture, but a stray delete would silently close a thread, and agent-authored notes report `editable: false`, so whether the TUI can delete them at all is unverified. Deletion tracking is kept for the user's own un-submitted notes only, where deleting is exactly what the user means.
- **The agent resolves change requests when it replies.** Hides a wrong "done". Out of scope; `/resolve` is the reviewer's alone.
- **Show each reply once with a reviewer-level seen flag.** Fixes the pile-up but makes an unresolved discussion vanish after a glance. Rejected.
