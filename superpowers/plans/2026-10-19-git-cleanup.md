# `git cleanup` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `git-cleanup`, `git-delete-squashed` and `git-list-squashed` with one bash `git cleanup` that dry-runs a plan for dead branches and worktrees in the current repo, executes under `--yes`, and layers GitHub PR state on top when `gh` and `jq` are available.

**Architecture:** One bash script, `local/bin/git-cleanup`, structured as: resolve repo facts, gather worktree map, optionally fetch PR state by branch through one batched GraphQL request per 50 branches, classify each branch with first-match-wins rules, print the plan, execute under `--yes`. One bash test file with a fixture repo and a fake `gh` on PATH, run from `script/test` like the other `*_test.sh` files.

**Tech Stack:** bash 3.2-compatible (macOS `/bin/bash` is 3.2; `#!/usr/bin/env bash` may resolve to 5.x via Homebrew, so avoid associative arrays and `mapfile`), git, coreutils; optional `gh`, `jq`.

**Spec:** `/Users/jake/.dotfiles/superpowers/specs/2026-10-19-worktree-cleanup-design.md`, section "`git cleanup`" (decisions 1–8) plus Goals, Anti-goals and Constraints.

## Global Constraints

- Scope is the repo containing the current directory; never another repo (decision 1).
- Dry run by default; `--yes` executes; no interactive prompt (decision 2).
- Order: `git worktree prune`, classify, then per branch `git worktree remove <path>` then `git branch -D <branch>` (decision 3).
- Never check out main or any branch (anti-goal).
- Never delete a dirty worktree, a closed-unmerged PR's branch without `--closed`, or a branch with unmerged commits and no PR (anti-goal).
- `gh` path requires `gh` and `jq` on PATH, `gh auth status` succeeding, and a GitHub `origin` (decision 5); when any is missing, print one header line `gh not available: PR state unknown` (decision 6).
- Every branch appears exactly once in the output with disposition and reason (decision 6).
- Script knows nothing about workbench (non-goal).
- `git-delete-squashed` and `git-list-squashed` are deleted, no shim (decision 7).

## Review Focus

Inputs the spec implies but no rule names; each has a test added to Task 2 or Task 3 below.

1. The main checkout sitting on a non-default branch while the command runs from a linked worktree: the main checkout cannot be `git worktree remove`d and `git branch -D` fails on a checked-out branch, so the plan must `skip` it with `checked out in <main worktree>` rather than fail mid-run. (Task 1, test 2)
2. Detached worktrees (no `branch` line in `git worktree list --porcelain`): they are not branches and must be ignored, not deleted. (Task 1)
3. Branch names containing `/`, `.`, `-` and `"`: the GraphQL alias must be `b<N>`, never the branch name, and the `headRefName` string must be JSON-escaped via `jq`. (Task 3)
4. More than 50 local branches (infrastructure has 133): batching must produce correct results across batch boundaries. (Task 3)
5. `gh api graphql` failing after `gh auth status` succeeded (network, rate limit): treat as `gh` unavailable for this run, print the header line, fall back to pure-git rules, exit 0. (Task 3)

---

### Task 1: Pure-git classification and dry run

**Files:**
- Rewrite: `local/bin/git-cleanup`
- Create: `test/git_cleanup_test.sh`
- Modify: `script/test` (add a block for `test/git_cleanup_test.sh` matching the existing `*_test.sh` blocks)

**Interfaces:**
- Produces: `git cleanup [--yes] [--closed]`. Output lines, one per branch, tab-separated: `<disposition>\t<branch>\t<worktree-or-->\t<reason>` where disposition is `delete`, `worktree` or `skip`. Header line 1 is `repo: <toplevel of main worktree>  default: <branch>`; header line 2 is either `gh: <slug>` or `gh not available: PR state unknown`. `git worktree prune` output (dry run: `--dry-run -v`) follows the headers. Exit 0 on a successful plan or run; exit 1 if any `--yes` step fails (the run continues past failures and reports them); exit 2 on usage error.
- Internal shell functions (Task 3 extends `classify`): `default_branch`, `current_branch`, `worktree_of <branch>`, `is_dirty <path>`, `ancestry_merged <branch>`, `squash_merged <branch>`, `ahead_count <branch>`, `classify <branch>` (prints one output line).

- [ ] **Step 1: Write the fixture and failing tests in `test/git_cleanup_test.sh`**

Follow `test/mdprint_test.sh`: `set -eo pipefail`, `fixture="$(mktemp -d)"`, `trap 'rm -rf "$fixture"' EXIT`, `fake_bin="$fixture/bin"` prepended to PATH, `git` config isolated with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` and author/committer env. A helper `mk_repo` creates `$fixture/repo` with `git init -q -b main`, one empty commit, a bare `$fixture/origin.git` added as `origin` with `main` pushed, so `refs/remotes/origin/HEAD` resolves. Helpers `assert_line <disposition> <branch> <reason-substring>` and `assert_absent <branch>` grep the captured output.

Fixture branches, all created from `main`:
- `merged-ancestry`: one commit, merged into `main` with `git merge --no-ff`; has a worktree at `$fixture/repo/.worktrees/merged-ancestry`.
- `merged-squash`: one commit touching `a.txt`; `main` gets `git merge --squash merged-squash && git commit`; worktree at `.worktrees/merged-squash`.
- `zero-ahead`: no commits; worktree at `.worktrees/zero-ahead`.
- `unmerged`: one commit not in `main`; no worktree.
- `dirty-merged`: one commit, merged with `--no-ff`; worktree at `.worktrees/dirty-merged` with an untracked file written into it.
- `elsewhere`: no commits, checked out in a worktree at `.worktrees/elsewhere`. A branch checked out in a worktree other than the current one is deletable: its worktree is removed first, then the branch. Only the *current* worktree's branch is protected (reason `current`). Review Focus 1 is covered by test 2 below, which runs from inside a worktree.
- A detached worktree: `git worktree add --detach .worktrees/detached main` (Review Focus 2).
- `gone-dir`: worktree added at `.worktrees/gone-dir`, then the directory `rm -rf`'d, so `git worktree prune` has something to do.

Tests (each runs `git -C <cwd> cleanup`, captures stdout, and asserts):
1. `test_dry_run_plans_from_main`: from `$fixture/repo`, no `gh` on PATH. Assert: header line 2 is `gh not available: PR state unknown`; `delete merged-ancestry` reason `ancestry-merged`; `delete merged-squash` reason `squash-merged`; `delete zero-ahead` reason `zero commits ahead`; `skip unmerged` reason `unmerged work`; `skip dirty-merged` reason `dirty, 1 file`; `main` absent; no line mentions `detached`; output contains `.worktrees/gone-dir` from `worktree prune --dry-run -v`; afterwards `git branch` still lists every branch and every `.worktrees/*` directory still exists.
2. `test_dry_run_skips_current_and_main_checkout`: first `git -C $fixture/repo checkout -q -b main-feature` (zero commits), then run from `$fixture/repo/.worktrees/zero-ahead`. Assert `skip zero-ahead` reason `current`; `skip main-feature` reason `checked out in $fixture/repo`; `delete merged-ancestry` still present (scope is the whole repo from any worktree). Restore with `git -C $fixture/repo checkout -q main` afterwards.
3. `test_yes_executes_plan`: from `$fixture/repo` with `--yes`. Assert exit 0; `merged-ancestry`, `merged-squash`, `zero-ahead` branches gone and their worktree dirs gone; `unmerged`, `dirty-merged` branches remain; `.worktrees/dirty-merged` still exists with its untracked file; `.worktrees/gone-dir` no longer in `git worktree list`.
4. `test_usage_error`: `git cleanup --bogus` exits 2 and prints `usage:` on stderr.

- [ ] **Step 2: Run the test to verify it fails**

Run: `test/git_cleanup_test.sh`
Expected: FAIL (the current script has no `--yes`, prints nothing structured, and runs `git branch -d` immediately).

- [ ] **Step 3: Rewrite `local/bin/git-cleanup`**

`#!/usr/bin/env bash`, `set -eo pipefail`. Parse `--yes`, `--closed`, `-h|--help`; anything else prints `usage: git cleanup [--yes] [--closed]` to stderr and exits 2. Resolve `main_wt` as the first `worktree` line of `git worktree list --porcelain`; run all git commands with `git -C "$main_wt"` except `current_branch` and `is_dirty`, which use the real cwd and the branch's own worktree. `default_branch`: `git symbolic-ref --short -q refs/remotes/origin/HEAD` with `origin/` stripped, else `main` if it exists, else `master`. Print the two header lines (Task 1 always prints the "not available" form; Task 3 adds the other). Run `git worktree prune --dry-run -v` (dry) or `git worktree prune -v` (`--yes`). Build the worktree map by parsing `--porcelain` into parallel arrays (bash 3.2: no `declare -A`), skipping detached entries. Iterate `git for-each-ref refs/heads --format='%(refname:short)'`, call `classify`, collect lines in an array, print them. Under `--yes`, for each `delete` line run `git worktree remove <path>` (if any) then `git branch -D <branch>`; for each `worktree` line only the remove; echo each command before running it; record failures and exit 1 at the end if any.

`classify` rule order (Task 1): default branch → not printed; branch equals `current_branch` → `skip … current`; branch is checked out in `main_wt` → `skip … checked out in <main_wt>`; worktree dirty → `skip … dirty, N file(s)` using `git -C <wt> status --porcelain | wc -l`; `ancestry_merged` (`git merge-base --is-ancestor <branch> <default>`) → `delete … ancestry-merged`; `squash_merged` (today's `list-squashed` expression: `git cherry <default> $(git commit-tree <branch>^{tree} -p $(git merge-base <default> <branch>) -m _)` begins with `-`) → `delete … squash-merged`; `ahead_count` (`git rev-list --count <default>..<branch>`) is 0 → `delete … zero commits ahead`; else `skip … unmerged work`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `test/git_cleanup_test.sh`
Expected: PASS, all four tests.

- [ ] **Step 5: Wire into `script/test` and commit**

Add a block for `test/git_cleanup_test.sh` identical in shape to the `test/mdprint_test.sh` block. Run `script/test`; expected: the new block passes, nothing else changes.

```bash
git add local/bin/git-cleanup test/git_cleanup_test.sh script/test
git commit -m "git-cleanup: dry-run plan for dead branches and worktrees, --yes to execute"
```

---

### Task 2: Remove the old scripts

**Files:**
- Delete: `local/bin/git-delete-squashed`, `local/bin/git-list-squashed`
- Modify: `test/git_cleanup_test.sh`

**Interfaces:**
- Consumes: Task 1's script.

- [ ] **Step 1: Add the failing test**

`test_old_scripts_removed`: assert `! [ -e "$dotfiles_root/local/bin/git-delete-squashed" ]` and the same for `git-list-squashed`.

- [ ] **Step 2: Run to verify it fails**

Run: `test/git_cleanup_test.sh`
Expected: FAIL on `test_old_scripts_removed`.

- [ ] **Step 3: Delete the scripts**

```bash
git rm local/bin/git-delete-squashed local/bin/git-list-squashed
```

Also grep the repo for `delete-squashed` and `list-squashed` (`aliases`, `zsh/`, `README.md`) and remove any reference.

- [ ] **Step 4: Run to verify it passes**

Run: `test/git_cleanup_test.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A local/bin test/git_cleanup_test.sh
git commit -m "git-cleanup: absorb delete-squashed and list-squashed"
```

---

### Task 3: `gh` enhancement, PR state by branch name

**Files:**
- Modify: `local/bin/git-cleanup`
- Modify: `test/git_cleanup_test.sh`

**Interfaces:**
- Consumes: Task 1's `classify` and output format.
- Produces: shell functions `gh_available` (0 when `gh`, `jq` on PATH, `gh auth status` exits 0, and `origin` URL matches `github.com[:/]<owner>/<repo>`), `origin_slug`, `fetch_pr_states <branch>...` (fills parallel arrays `pr_branch[]`, `pr_state[]`, `pr_number[]` from one `gh api graphql` call per 50 branches; on any non-zero exit, clears `gh_ok` so the run falls back), and the extended `classify`.

- [ ] **Step 1: Write the fake `gh` and failing tests**

Fake `gh` at `$fake_bin/gh`: `gh auth status` exits `${FAKE_GH_AUTH_EXIT:-0}`; `gh api graphql ...` writes its `-f query=...` argument to `$FAKE_GH_QUERY_LOG` (append) and prints the file `$FAKE_GH_RESPONSE` (or exits 1 when `FAKE_GH_FAIL=1`). Fake `jq` is not needed: the real `jq` is required on the test machine; skip the gh tests with a message if `jq` is absent.

Response fixture: the test builds the JSON by matching alias order to the branch list the script sends, so the test must read the logged query, extract `b<N>` → `headRefName` pairs with `grep -o`, and emit `{"data":{"repository":{"b0":{"nodes":[...]}, ...}}}` where a branch's node is `[{"number":N,"state":"MERGED"}]` etc., or `[]`. Simplest: make the fake `gh` itself generate the response from the query using a small state table in env `FAKE_GH_PRS` formatted `branch=STATE:number` space-separated; branches absent from the table return `[]`.

Additional fixture branches: `pr-merged` (one commit, not merged locally, worktree), `pr-closed` (one commit, worktree), `pr-open` (one commit, worktree), `weird/na.me-"q"` (no commits, created with `git branch`, Review Focus 3), and 55 branches `bulk-<N>` with no commits (Review Focus 4).

Tests:
5. `test_gh_header_when_available`: header line 2 is `gh: <owner>/<repo>` (the fixture's origin is a local bare path, so set the origin URL to `git@github.com:acme/repo.git` for gh tests with `git remote set-url`, and point `pushurl` back at the bare path if any test pushes).
6. `test_gh_states`: `FAKE_GH_PRS="pr-merged=MERGED:11 pr-closed=CLOSED:12 pr-open=OPEN:13"`. Assert `delete pr-merged` reason `PR #11 merged`; `worktree pr-closed` reason `closed PR #12, branch kept`; `skip pr-open` reason `open PR #13`; `delete zero-ahead` still `zero commits ahead` (no-PR fallthrough); `skip dirty-merged` still `dirty` (dirty precedes PR rules).
7. `test_gh_closed_flag`: same table with `--closed`; assert `delete pr-closed` reason `closed PR #12`.
8. `test_gh_yes_closed_keeps_branch`: `--yes` without `--closed`; assert `.worktrees/pr-closed` gone and branch `pr-closed` still exists.
9. `test_gh_escapes_and_batches`: the query log contains `\"q\"` for the weird branch and the aliases are `b0..b49` in the first request and `b0..` in a second (two requests logged); `delete weird/na.me-"q"` present with `zero commits ahead`.
10. `test_gh_api_failure_falls_back`: `FAKE_GH_FAIL=1`; header line 2 is `gh not available: PR state unknown`; exit 0; `delete merged-ancestry` still present.
11. `test_gh_unauthenticated_falls_back`: `FAKE_GH_AUTH_EXIT=1`; same assertions as test 10.

- [ ] **Step 2: Run to verify they fail**

Run: `test/git_cleanup_test.sh`
Expected: FAIL on tests 5–11 (header always says not available).

- [ ] **Step 3: Implement the `gh` path**

`fetch_pr_states`: for each batch of 50 branches build the query with `jq -n --args '...' "$@"`-style escaping producing `{ repository(owner:"O", name:"R") { b0: pullRequests(headRefName: <json-string>, last: 1, orderBy: {field: CREATED_AT, direction: ASC}, states: [OPEN, MERGED, CLOSED]) { nodes { number state } } b1: ... } }`, run `gh api graphql -f query="$q"`, parse with `jq -r '.data.repository | to_entries[] | "\(.key)\t\(.value.nodes[0].state // "")\t\(.value.nodes[0].number // "")"'`, map `b<N>` back to the batch's branch. `last: 1` ordered by `CREATED_AT` ascending gives the newest PR (decision 5, "newest by number wins").

Extend `classify`: after the dirty rule and before `ancestry_merged`, when `gh_ok` and the branch has a state: `MERGED` → `delete … PR #N merged`; `CLOSED` → with `--closed` `delete … closed PR #N`, else `worktree … closed PR #N, branch kept` (if the branch has no worktree, print `skip … closed PR #N, branch kept`); `OPEN` → `skip … open PR #N`. Header line 2 becomes `gh: <slug>` when `gh_ok` after the fetch.

- [ ] **Step 4: Run to verify they pass**

Run: `test/git_cleanup_test.sh`
Expected: PASS, tests 1–11.

- [ ] **Step 5: Acceptance against the real repo and commit**

Run: `cd ~/Code/abridgeai/infrastructure && git cleanup`
Expected: header `gh: abridgeai/infrastructure`; every `delete` or `worktree` line names a branch whose PR is `MERGED` or `CLOSED`, or has no PR and zero commits ahead; no line with reason `open PR` is a `delete`. Count the `delete`+`worktree` lines whose reason mentions a PR and compare with `gh pr list --author @me --state merged` ∪ `closed` restricted to local branches; they must match. Paste the dry-run output into the commit message body.

```bash
git add local/bin/git-cleanup test/git_cleanup_test.sh
git commit -m "git-cleanup: classify by GitHub PR state looked up per branch"
```
