# Worktree and workset cleanup — Design Spec

**Status:** Approved 2026-10-19 (brainstormed, builder-checked); not yet implemented.
**Date:** 2026-10-19
**Owner:** jacob@smithjs.org
**Related:** `docs/superpowers/specs/2026-10-10-workbench-design.md` (workbench), `local/lib/workbench/CONTEXT.md` (glossary)

## Intent

Two tools, both manual, both in this dotfiles repo:

1. **`git cleanup`**, rewritten. One pure-git command, scoped to the repo
   containing the current directory, that deletes dead branches and their
   worktrees. It replaces `git-cleanup`, `git-delete-squashed` and
   `git-list-squashed`. It is progressively enhanced when `gh` is installed
   and authenticated, and it knows nothing about workbench.
2. **workbench workset triage.** `workset list` becomes an overview that
   shows which worksets matter, `workset rename` makes naming a workset one
   command (naming is the pin), and `workset prune` operates on whole
   worksets instead of unclaimed item ids.

## Why

On 2026-10-19 the 20 repos under `~/Code/abridgeai` held 133 non-main
worktrees: 32 behind merged PRs, 12 behind closed PRs, 40 behind open PRs,
49 with no PR. 15 worktree entries pointed at directories that no longer
exist. Worktrees were spread over `.worktrees/`, `.claude/worktrees/`,
`/tmp/worktrees` and stale Claude scratchpad directories. workbench held 13
worksets, 11 of them default-named `claude-<id>`, and 29 closed session
pointers. Nothing today removes a merged branch except the owner by hand, so
every tool that keys off "branch gone" never fires, and the overview that
would tell the owner which worksets are still live does not exist.

The existing scripts are three lines each: `git cleanup` deletes
ancestry-merged branches, `git delete-squashed` runs the commit-tree squash
check and prompts y/N, and neither knows about worktrees or GitHub.
`workbench workset prune <id>` only deletes *unclaimed* items one at a time
and has never been used.

## Goals

- One `git cleanup` invocation in a repo leaves behind only branches with
  live or unknown work, and reports every skip with its reason.
- `workbench workset list` answers "which of these worksets do I still
  care about" in one screen.
- Collecting a dead workset, or all dead default worksets, is one command.
- Nothing is deleted without `--yes`, in either tool.

## Non-goals

- Automatic cleanup of any kind. No garbage collection at SessionEnd,
  SessionStart or on a timer. The one existing automatic step stays as it
  is: SessionEnd deletes a default workset that never gained a member.
- A pin flag. Naming a workset is the pin; default-named worksets are the
  only ones a sweep may collect.
- Cross-repo `git cleanup`. It is a git subcommand scoped like
  `git branch`; running it across 20 repos is 20 invocations.
- `git cleanup` reading workbench state. The two tools are independent;
  `workbench workset prune` covers worktrees that workbench cares about.
- Hand-pruning today's inventory. The owner will use the new tooling.

## Anti-goals

- Deleting a branch whose commits exist nowhere else. A closed-but-unmerged
  PR, a branch with commits ahead of main and no PR, or a dirty worktree
  must never be deleted without an explicit flag or explicit confirmation.
- Checking out main as a side effect (today's `list-squashed` does). It
  fails whenever main is checked out in another worktree.

## Constraints

- `git cleanup` is bash, lives at `local/bin/git-cleanup` (rcm-linked to
  `~/.local/bin/git-cleanup`), and depends only on git, coreutils and,
  optionally, `gh` and `jq`. If `jq` is required for the `gh` path, its
  absence disables the `gh` enhancement rather than failing the command.
- workbench changes are TypeScript on Bun in `local/lib/workbench/`, tested
  with `bun test`, following the existing module layout (`src/cmd/*.ts`
  commands, logic in `src/*.ts`, tests in `test/`).
- The repo's default branch is whatever `git.defaultBranch` / the
  `init.defaultBranch`-style detection says; the scripts must not hardcode
  `main`, though `main` is the case that matters.

## Decisions

### `git cleanup`

1. **Scope.** The repo containing the current directory, found with
   `git rev-parse --show-toplevel` / `--git-common-dir`. Works from inside
   any worktree of the repo, not only the main checkout. Never touches
   another repo.
2. **Dry run by default.** Prints the plan grouped as *delete*, *remove
   worktree only*, *skip (reason)*, and exits 0 without changing anything.
   `--yes` executes the plan. There is no interactive prompt.
3. **Order of operations.** First `git worktree prune` (entries whose
   directories are gone). Then classify every local branch except the
   default branch. Then, under `--yes`, for each branch: `git worktree
   remove <path>` if it has a worktree, then `git branch -D <branch>`.
4. **Pure-git rules** (always applied, in this order; first match wins):
   - Default branch, or the branch checked out in the current worktree:
     skip.
   - Worktree has uncommitted changes (`git status --porcelain
     --untracked-files=normal --ignore-submodules=none` in the worktree is
     non-empty, so repo config cannot hide untracked files): skip, report
     the file count. A locked worktree is skipped with reason `locked`.
   - Ancestry-merged into the default branch (`git branch --merged`):
     delete.
   - Squash-merged: the commit-tree check from today's `list-squashed`
     (`git cherry <default> $(git commit-tree <branch>^{tree} -p <merge-base> -m _)`
     reports `-`): delete.
   - Zero commits ahead of the default branch (`git rev-list --count
     <default>..<branch>` is 0) and clean: delete.
   - Otherwise: skip, "unmerged work".
5. **`gh` enhancement.** Enabled when `gh` and `jq` are on PATH, `gh auth
   status` succeeds, and the repo has a GitHub `origin`. PR state is
   looked up **by local branch name**, not by author or date: one
   `gh api graphql` request per batch of up to 50 branches, each branch an
   aliased `pullRequests(headRefName: ..., last: 1, orderBy: {field:
   CREATED_AT, direction: ASC}, states: [OPEN, MERGED, CLOSED])` field on
   the repository, returning `number` and `state`. A date window was
   rejected: the oldest dead worktrees are the ones cleanup exists for.
   It adds rules evaluated *before* the pure-git rules, after the
   skip-if-dirty rule:
   - PR `MERGED`: delete, **guarded by the PR head SHA** (added after the
     Task 3 review, 2026-10-19): the node also returns `headRefOid`, and the
     rule fires only when the local tip equals it, or the object is known
     locally and the local tip is an ancestor of it. When the object is not
     known locally the script first runs `git fetch -q origin
     refs/pull/<N>/head` (GitHub keeps that ref after merge) and re-checks,
     because the common case is a local branch *behind* the PR head, not
     ahead of it. A branch name reused
     after its PR merged, or a same-named branch from a fork, therefore
     falls through to the pure-git rules instead of being deleted.
   - PR `CLOSED` (not merged): first run the pure-git rules; if the
     branch is ancestry-merged, squash-merged or zero commits ahead of the
     default branch, delete it with that reason plus "(closed PR #N)",
     because a closed PR says nothing about commits main already holds
     (added 2026-10-19 after the first live run). Otherwise remove the
     worktree, keep the branch, report "closed PR #N, branch kept". With
     `--closed`, delete the branch too. The same head-SHA guard applies (final review, 2026-10-19): a closed
     PR whose head does not cover the local tip is a reused name, and the
     branch falls through to the pure-git rules instead.
   - PR `OPEN`: skip, "open PR #N".
   - No PR: fall through to the pure-git rules.
   When the same branch has several PRs, the newest by number wins.
6. **Reporting.** Every branch appears in the output exactly once with its
   disposition and reason, and the PR number when known. When `gh` is
   unavailable the header says so in one line ("gh not available: PR state
   unknown"), so the owner knows closed and open PRs are not being
   distinguished.
7. **Removal of the old scripts.** `git-delete-squashed` and
   `git-list-squashed` are deleted from `local/bin/`. No alias or shim is
   kept.
8. **Acceptance.** Run in `~/Code/abridgeai/infrastructure` on 2026-10-19,
   a dry run proposes exactly the 14 worktrees whose PRs are merged or
   closed, lists the 40-ish open-PR and no-PR branches as skips, and
   proposes no branch with an open PR. The inventory used to derive those
   counts is the `gh pr list` join described above; the builder should
   re-derive it rather than trust these numbers.

### workbench

9. **`workset list` is the overview.** One row per workset, columns:
   name; `default` or `named`; member count; PR mix as counts of merged,
   closed, open and no-PR members; number of dirty worktrees; bound
   sessions as `N open / M stale / K closed` with the most recent pointer
   or transcript timestamp;
   suggested action. Below the table, one line per repo root with its
   unclaimed item count, so the owner knows where to run `git cleanup`.
   `--json` emits the same data. The unclaimed footer needs a full
   derivation across every repo root (about 30 s on the owner's machine),
   so it is produced only with `--unclaimed` (final review, 2026-10-19).
10. **Suggested action**, first match wins:
    - `review`: an unread review is in a bound session's inbox, or a lock
      is held for the workset.
    - `prune`: every member is prunable (decision 13) or missing.
    - `name`: default-named and any member has an open PR, unpushed
      commits, or a dirty worktree.
    - `-`: otherwise (a named workset with live work, or a default-named
      one with nothing to decide).
    Rows sort by action in the order above, then by most recent session
    activity. `prune` and `name` rows are what the owner acts on.
11. **PR state** for members comes from a new `gh.prsForBranches(slug,
    branches)` that issues the same batched GraphQL lookup by
    `headRefName` as `git cleanup` (decision 5), not from the `pr` field
    stored on the member, which may be stale, and not from `gh.myPrs`,
    whose `--limit 100` author listing misses older PRs (the owner has
    more than 150 in `infrastructure`). The stored `pr` field is updated as
    a side effect when they differ. `derive` keeps `gh.myPrs` only for
    surfacing unclaimed PRs that have no local branch.
12. **`workset rename <old> <new>`.** Renames the workset file and updates
    every session pointer bound to `<old>`, the lock file, review archives
    directory, notes directory and any inbox entries that name the
    workset. Refuses if `<new>` exists or fails the name regex. Naming is
    the pin: a workset whose name does not match `^<harness>-<uuid>$` is
    *named*. Rename refuses while a review lock is held for the
    workset, the same as prune (builder-check call): the open review
    file, the `wb-<name>` tmux session and the running sidebar all key
    off the name, so renaming under them would strand the review.
13. **A member is prunable** when its PR is `MERGED` and the same head-SHA
    guard as decision 5 holds (`prsForBranches` returns `headRefOid`), or
    its upstream is gone (`git.upstreamGone`) *and* its local tip is an
    ancestor of, or zero commits ahead of, the repo's default branch (added
    after the Task 3 review: a gone upstream alone says nothing about
    local-only commits), or its branch no longer exists in its repo, or its
    repo no longer exists, or its PR is `CLOSED` *and* its tip is in the
    default branch (reason `merged into <default> (closed PR)`; a closed
    PR with a tip not in the default branch stays `closed PR`, not
    prunable). The dirty and open-session exclusions below apply
    to every one of these, including a member whose branch or repo is gone
    but whose worktree directory still exists. This is the existing `prunable` rule
    plus the two "already gone" cases. `CLOSED` is *not* prunable; the
    owner deals with those through `git cleanup --closed` or by hand.
    Two exclusions (builder-check calls): a member whose worktree has
    uncommitted changes is not prunable and is reported as "dirty, N
    files", which pushes a default workset to the `name` action; and a
    member whose worktree is the `cwd` of an open session pointer is not
    prunable and is reported as "cwd of open session <key>". There is no
    force flag; `pruneWorktreeAndBranch` keeps using plain
    `git worktree remove`.
14. **`workset prune`** replaces `prune <id>`; the id form is removed.
    - No argument: lists every *default-named* workset whose members are
      all prunable, with the plan for each. `--yes` executes against all of
      them.
    - `prune <name>`: for any workset, named or default, prunes its
      prunable members (worktree remove, then branch delete; skip the git
      steps for already-gone members) and removes them from the workset. If no members remain,
      deletes the workset. Members that are not prunable are kept and
      listed with the reason. `--yes` executes.
    - **Session liveness.** A pointer is *open* only when it has no
      `closed` timestamp *and* its harness session is alive. For Claude
      Code, alive means the transcript file
      `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project-dir>/<session-id>.jsonl`
      was modified within the last 24 hours, where `<project-dir>` is the
      cwd with every non-alphanumeric character replaced by `-` (final
      review, 2026-10-19: slashes alone was wrong), falling back to a
      search of `projects/*/<session-id>.jsonl`. No transcript found means
      unknown, and unknown counts as open: liveness feeds deletion, so it
      fails open. A pointer with no `closed` timestamp that
      fails the liveness check is *stale*: the overview shows it as
      `stale`, and prune treats it as closed, closing it (setting
      `closed` to now, with `closed_reason: "stale"`) before deleting it.
      Liveness lives in the harness adapter so a second harness supplies
      its own check. The 24-hour window is a constant, not config.
    - Deleting a workset also deletes closed session pointers bound only to
      that workset, their inbox directories and any watch or pid files for
      them, and the workset's notes directory. Review archives under
      `reviews/<workset>/` are kept. Open pointers are never deleted; if any
      pointer bound to the workset is open (live, per the liveness rule),
      the workset file is kept even when empty and the output says why.
    - A locked workset (a review is open) is refused.
    - **Worktree ownership** (Task 5 review, 2026-10-19): a member's
      worktree is removed only while that worktree's HEAD is the branch of
      a prunable member in the same plan; a worktree switched to another
      branch or detached is left alone (final review, 2026-10-19: the
      stored path is a hint; planning asks git which worktree, if any, has
      the member's branch checked out, removes that one, never the main
      checkout, and deletes the branch with `update-ref -d` against the
      planned tip; a branch checked out nowhere gets only the branch
      delete). A member shared with another workset is pruned on its own
      merits; the delete removes the member record from every workset of
      the same checkout that lists it and re-points their stack bases the
      same way, skipping sibling worksets that hold a review lock (an
      earlier symmetric "also in workset" guard made shared dead branches
      unprunable and was dropped during acceptance). Execution
      re-reads pointer and workset state before closing or deleting
      anything, so a pointer that became live or a workset that regained
      members since the plan is left alone. The dry run also prints
      `nothing to run for <id>: <reason>` for an already-gone member.
    - **Stacks** (builder-check call): worksets here are stacks, each
      member's `base` naming the previous member's branch. When a member
      is pruned, every remaining member whose `base` was the pruned branch
      gets a new base: the PR's current `baseRefName` when the member has
      a PR (GitHub retargets stacked PRs when their base merges), else the
      pruned member's own `base`, collapsing the chain. `base_source`
      becomes `pr` or stays as it was. The same refresh of `base` from
      `baseRefName` happens in the decision-11 side effect for members
      with a PR.
15. **`scan`** keeps its per-item view unchanged. `adopt` and `ignore` stay.
16. **Usage text and README** are updated to match; the `prune <id>` line
    is removed.

## Left to the builder

- Exact output formatting of both tools, as long as decisions 6 and 9 hold.
- How the overview computes "unpushed commits" for a member (ahead of
  upstream, or no upstream and ahead of base).
- Test strategy for `git cleanup` (a scratch repo fixture under `bun test`,
  a bats file, or a shell test under `test/`; the repo already has `test/`
  for dotfiles).
- Column widths and truncation in the overview.

## Alternatives considered

- **Automatic garbage collection** of default worksets at SessionEnd or
  SessionStart: rejected. Session end is when review starts, not when work
  ends, and the owner wants no deletion to ever happen without a command.
- **`git cleanup` across all repos**: rejected; a git subcommand is scoped
  to a repo like every other git subcommand.
- **`git cleanup` as a `workbench prune --repo` shim**: rejected; the git
  tool must work with Bun, workbench and `gh` all absent.
- **Keeping `prune <id>`**: rejected; unclaimed dead branches are exactly
  `git cleanup`'s job, and the id form was never used.
- **Treating CLOSED like MERGED**: rejected; closed sometimes means
  superseded by another stack and the commits are the only copy.
- **An explicit pin flag**: rejected; naming is the pin.
