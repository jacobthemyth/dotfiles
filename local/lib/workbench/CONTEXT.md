# Workbench

Workbench joins what coding agents produce (branches, worktrees, pull requests, across repos) to how one person reviews it in a terminal: one view per piece of work, comments and edits that flow back to the agent.

## Language

### Work

**Workset**:
Every branch, worktree and pull request that one piece of work produced, across repos, with a stack order. The unit of review.
_Avoid_: stack, project, session, PR set

**Member**:
One branch of a workset, with its repo, worktree, diff base, pull request and role.
_Avoid_: entry, item, target

**Role**:
What a member is for: `work` (reviewed and locked) or `throwaway` (hidden by default, never locked, never reviewed).

**Stack**:
The ordering of a workset's members in one repo by pull request base, where one member's branch is another's base.
_Avoid_: chain, train

**Diff base**:
The ref a member's diff is taken against: its pull request's base, else its declared base, else the repo's default branch.

**Unclaimed**:
A branch, worktree or pull request of yours that derivation found and no workset claims. Adopted, ignored or pruned.
_Avoid_: orphan, stray

**Central repo**:
A shared checkout on its default branch that collects a workset's docs and ledgers without a branch of its own. Excluded from worksets for now.
_Avoid_: ledger repo, workspace repo

### Agents

**Harness**:
The agent runtime a session runs in. Claude Code today; others later through their own adapter.
_Avoid_: agent (the thing inside it), CLI

**Session**:
One run of a harness, identified by the harness's own session id and bound to exactly one workset.

**Pointer**:
The per-session record that says which workset a session is bound to. Created at session start, closed at session end.
_Avoid_: binding, link

**Adapter**:
The thin translation from one harness's hook protocol to Workbench's generic events (session started or ended, about to write a path, about to run a command, prompt submitted, turn ended).

### Review

**Review**:
One batch of comments and edits against a workset, delivered to every bound session when submitted.
_Avoid_: feedback, round, pass

**Comment**:
A typed note anchored to a repo, path, line range and the commit it was made against. Types: change request (default), question, note.
_Avoid_: annotation, remark

**Edit**:
A change you make to a member's file during a review, committed at submit as your own commit.
_Avoid_: fix, patch, tweak

**Lock**:
The hold a review places on every `work` member's worktree while it is open. Agents yield edits and writing commands in locked paths.
_Avoid_: freeze, mutex, claim

**Submit**:
The act that commits your edits, writes the review to each bound session's inbox, releases the lock and wakes the agents.

**Close**:
Leaving a review without submitting: the lock is released and comments are kept.
_Avoid_: cancel, abandon, discard

**Inbox**:
Where a session's submitted reviews wait to be read, and where agent replies are kept.
_Avoid_: queue, mailbox

**Reply**:
An agent's answer to a comment, shown beside it in the reviewer when one is open and kept in the inbox otherwise.
_Avoid_: response, resolution

### Surfaces

**Reviewer**:
The per-member diff view, which is hunk.
_Avoid_: viewer, pane (the tmux object)

**Sidebar**:
The workset tree rendered beside the reviewer: members with pull request state and stack position, unclaimed items, bound sessions and their state.
_Avoid_: tree, panel, navigator

**Review window**:
The tmux session `wb-<workset>` holding the sidebar and the reviewer.
_Avoid_: workspace
