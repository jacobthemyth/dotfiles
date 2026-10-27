---
name: workbench-review
description: Use when a system reminder says a workbench review arrived, or the user says to check the workbench inbox. Reads the review, treats the user's edit commits as canonical, works through change requests, and replies to questions and notes beside the comment.
---

# Workbench review

A review is a batch of comments and edits the user made in the review window against this session's workset.

Your session key is `claude-$CLAUDE_CODE_SESSION_ID`. Workbench reads it from the environment, so `--session <key>` is optional; pass it only if a command says it has no session key.

1. Run `workbench inbox show` (newest unread review) or `workbench inbox show <review id>`. Read all of it before acting. Each comment line gives its type, `path:lines`, and its id in parentheses, for example (id `user:1791644120301-1`).
2. For each repo in "Your edits were committed", run `git -C <worktree> log --oneline -5` and `git -C <worktree> show --stat <sha>`. Those commits are the user's and are canonical: build on them, never amend, rebase, squash or revert them. If the overall message explicitly says to squash, say so in your reply and do it only then.
   If there is a "Failed edits" section, those edits could not be committed and are left unstaged in the worktree. Commit them as the user's change before your own work (keep the user as author, e.g. `git commit --author`, if you can; otherwise say in a reply that you committed them as yourself).
3. Work through **change** comments in order. For each, make the change in the worktree, commit as usual, then `workbench reply --review <review id> --comment <comment id> --text "<what you did, one line, with the commit sha>"`.
4. Answer **question** comments with `workbench reply --review <review id> --comment <comment id> --text "<answer>"`. Keep answers to a few sentences; a change that follows from the answer is a separate change you make and reply about.
5. Acknowledge **note** comments only when they change what you do; otherwise leave them.
6. A thread listed under **Resolved**, or rendered as ~~resolved~~, needs no reply and no work; a question you answered that then shows there is closed.
7. End with one line in the conversation: review id, counts of changes made, questions answered, anything you disagreed with and why. Then resume what you were doing.

A reply is kept with the review and shown beside the comment in the reviewer, now if the window is open on that member, else the next time it opens there. `workbench reply` exits 1 if the review or comment id is wrong; check the id in `workbench inbox show`.

Never edit files under a locked worktree (a tool call is denied with the lock holder's name); wait for the lock to release.
