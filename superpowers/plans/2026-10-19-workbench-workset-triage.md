# workbench workset triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `workbench workset list` into a per-workset overview with a suggested action, add `workset rename`, and make `workset prune` operate on whole worksets (sweeping dead default-named ones with no argument), with no automatic deletion anywhere.

**Architecture:** A new `src/triage.ts` computes a `MemberStatus` per member and a `WorksetSummary` per workset from git state, a batched GraphQL PR lookup by branch name (`gh.prsForBranches`), session liveness (harness adapter), locks and inboxes. `cmd/workset.ts` renders summaries for `list`, and a new `src/prune.ts` plans and executes workset-level pruning from the same statuses. Session liveness lives in `src/harness/claude.ts` behind a generic `pointerState` in `src/session.ts`.

**Tech Stack:** TypeScript on Bun, `bun test`, `util.parseArgs`; `gh api graphql`; existing modules `git.ts`, `gh.ts`, `derive.ts`, `workset.ts`, `session.ts`, `review.ts`, `inbox.ts`, `stack.ts`.

**Spec:** `/Users/jake/.dotfiles/superpowers/specs/2026-10-19-worktree-cleanup-design.md`, section "workbench" (decisions 9–16) plus Non-goals and Anti-goals.

## Global Constraints

- No automatic deletion; the SessionEnd hook's deletion of an empty default workset is the only automatic step and stays unchanged (non-goal).
- Dry run by default; `--yes` executes (Goals).
- A workset is *named* when its name does not match `^<harness>-<uuid>$`; named worksets are excluded from the no-argument sweep (decision 12, 14).
- Prunable member: PR `MERGED`, or upstream gone, or branch missing in its repo, or repo missing; *not* prunable when `CLOSED`, when its worktree is dirty, or when its worktree is the `cwd` of an open pointer (decision 13).
- PR state comes from `gh.prsForBranches`, not the stored `pr` field and not `gh.myPrs`; the stored field is refreshed as a side effect (decision 11).
- Pointer state: `closed` when `closed` is set; else `open` when the harness session is alive (Claude: transcript mtime within 24 h); else `stale`. Prune closes stale pointers with `closed_reason: "stale"` before deleting them (decision 14).
- Rename and prune refuse while a lock exists for the workset (decisions 12, 14).
- Pruning deletes closed pointers bound only to the workset, their inbox dirs and `watch/<key>.pid`, and the workset's notes dir; keeps `reviews/<workset>/<id>.json` archives (decision 14).
- `scan`, `adopt`, `ignore` unchanged; `prune <id>` removed (decisions 14, 15).
- State paths only through `paths.ts` `sub()`; test isolation through `WORKBENCH_STATE_DIR`, `WORKBENCH_CONFIG`, `WORKBENCH_GH_STUB`.
- Run `bun test` and `bun run check` (tsc) before each commit; the suite is 171 tests green today.

## Review Focus

1. A member whose `repo` directory no longer exists: every `git` call returns null; status must be `gone`, prunable, with no git steps attempted. (Task 3)
2. A member with no `slug` (no GitHub origin): PR lookup is skipped for that repo and the member classifies by git alone. (Task 3)
3. A pointer whose `cwd` was deleted: the transcript path still derives from the stored `cwd`, so liveness must not throw when the directory is gone. (Task 2)
4. A workset whose two members share one worktree path (recorded by path and by slug before `findMember` unified them, or a hand-added duplicate): prune must remove the worktree once and not fail on the second member. (Task 5)
5. More than 50 members in one repo (`cinf-794-dev` has 17 today; a sweep across worksets batches per repo): `prsForBranches` must batch at 50 and merge results. (Task 1)

---

### Task 1: `gh.prsForBranches`

**Files:**
- Modify: `local/lib/workbench/src/gh.ts`
- Test: `local/lib/workbench/test/gh.test.ts` (new)

**Interfaces:**
- Produces: `export function prsForBranches(slug: string, branches: string[]): Map<string, { pr: Pr; base: string }>`. Branches with no PR are absent from the map. Newest PR per branch (`last: 1`, `orderBy: {field: CREATED_AT, direction: ASC}`, `states: [OPEN, MERGED, CLOSED]`). Batches of 50 aliases `b0..b49` per `gh api graphql -f query=…` call. Stub key `prsForBranches` in `WORKBENCH_GH_STUB`, whose value is an object `{ [branch]: { pr, base } }`. On any `gh` failure the map is empty and the module-level `export let lastGhError: string | null` is set, so callers can print `gh not available`; a successful call resets it to null.

- [ ] **Step 1: Write the failing tests**

```ts
test("prsForBranches returns the stub's map", () => { /* stub {"prsForBranches": {"a": {pr: {...state:"MERGED"}, base:"main"}}}; expect(prsForBranches("o/r", ["a","b"]).get("a")?.pr.state).toBe("MERGED"); expect(has("b")).toBe(false) */ });
test("buildQuery aliases by index and escapes names", () => { /* export buildBranchQuery(owner, repo, branches): string; assert it contains `b0: pullRequests(headRefName: "we\\"ird/na.me"` and `b1:`, never the branch text as an alias */ });
test("batches of 50", () => { /* export const BATCH = 50; with 120 branches, a spy on the internal runner (inject via `deps` param: prsForBranches(slug, branches, { run?: (q: string) => unknown })) is called 3 times with 50, 50, 20 aliases */ });
test("parseBranchResponse maps aliases back", () => { /* export parseBranchResponse(branches, json): Map; `{"data":{"repository":{"b0":{"nodes":[{"number":7,"url":"u","isDraft":false,"state":"OPEN","baseRefName":"main"}]},"b1":{"nodes":[]}}}}` → map has b0's branch only */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/.dotfiles/local/lib/workbench && bun test test/gh.test.ts`
Expected: FAIL, `prsForBranches is not exported`.

- [ ] **Step 3: Implement**

In `gh.ts`: `export const BATCH = 50;` `export function buildBranchQuery(owner: string, repo: string, branches: string[]): string` (use `JSON.stringify` for each `headRefName`; request `nodes { number url isDraft state baseRefName }`); `export function parseBranchResponse(branches: string[], json: unknown): Map<string, { pr: Pr; base: string }>`; `export function prsForBranches(slug, branches, deps = {})` that splits `slug` on `/`, batches, runs `gh api graphql -f query=<q>` through the existing `gh()` runner (or `deps.run`), and merges maps; set `lastGhError` on a null result.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test test/gh.test.ts && bun run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src/gh.ts local/lib/workbench/test/gh.test.ts
git commit -m "workbench: look up PR state per branch with batched GraphQL"
```

---

### Task 2: Session liveness and pointer state

**Files:**
- Modify: `local/lib/workbench/src/harness/claude.ts`, `local/lib/workbench/src/session.ts`
- Test: `local/lib/workbench/test/session.test.ts` (extend), `local/lib/workbench/test/claude-adapter.test.ts` (extend)

**Interfaces:**
- Produces, in `harness/claude.ts`: `export function transcriptPath(cwd: string, session: string): string` = `<projects>/<cwd with every "/" replaced by "-">/<session>.jsonl` where `<projects>` is `process.env.WORKBENCH_CLAUDE_PROJECTS ?? join(homedir(), ".claude/projects")`; `export function isAlive(cwd: string, session: string, nowMs = Date.now()): boolean` = transcript exists and `nowMs - mtimeMs < LIVENESS_MS` with `export const LIVENESS_MS = 24 * 60 * 60 * 1000`.
- Produces, in `session.ts`: `Pointer` gains `closed_reason?: "stale"`; `export type PointerState = "open" | "stale" | "closed"`; `export function pointerState(p: Pointer, nowMs = Date.now()): PointerState` dispatching on `p.harness` (`claude` → `isAlive`; unknown harness → `open` when not closed); `export function closeStale(p: Pointer): Pointer` sets `closed = now()`, `closed_reason = "stale"`, saves.

- [ ] **Step 1: Write the failing tests**

claude-adapter.test.ts: `transcriptPath("/Users/j/Code/x", "abc")` with `WORKBENCH_CLAUDE_PROJECTS=/p` is `/p/-Users-j-Code-x/abc.jsonl`; `isAlive` true for a file touched now, false for one with `utimesSync` set 25 h ago, false when missing; true for a file 23 h old; does not throw when `cwd` does not exist on disk (Review Focus 3).

session.test.ts: `pointerState` is `closed` when `closed` set regardless of transcript; `open` for a live transcript; `stale` for an old or missing one; `closeStale` writes `closed` and `closed_reason: "stale"` and `loadPointer` reads them back.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/session.test.ts test/claude-adapter.test.ts`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement** the functions above. `isAlive` wraps `statSync` in try/catch.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test test/session.test.ts test/claude-adapter.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src/harness/claude.ts local/lib/workbench/src/session.ts local/lib/workbench/test/session.test.ts local/lib/workbench/test/claude-adapter.test.ts
git commit -m "workbench: pointer state open/stale/closed from Claude transcript liveness"
```

---

### Task 3: Member status and workset summary (`src/triage.ts`)

**Files:**
- Create: `local/lib/workbench/src/triage.ts`
- Test: `local/lib/workbench/test/triage.test.ts` (new; copy `mkRepo`, `sh`, `ENV` and the `beforeEach`/`afterEach` env isolation from `test/derive.test.ts`)

**Interfaces:**
- Consumes: `gh.prsForBranches` (Task 1), `pointerState` (Task 2), `git.isDirty`, `git.dirtyFiles`, `git.upstreamGone`, `git.revParse`, `git.heads`, `review.loadLock`, `inbox.unreadCount`, `session.listPointers`, `workset.loadWorkset`/`listWorksets`.
- Produces:
  ```ts
  export type PrState = "merged" | "closed" | "open" | "nopr";
  export type MemberStatus = {
    member: Member; pr: PrState; prNumber: number | null; prBase: string | null;
    branchExists: boolean; repoExists: boolean; worktreeExists: boolean;
    dirty: number;            // dirty file count, 0 when clean or no worktree
    unpushed: boolean;        // commits ahead of upstream, or no upstream and ahead of diffBase
    cwdOf: string | null;     // key of an open pointer whose cwd is this worktree
    prunable: boolean; reason: string; // reason: "merged" | "remote-gone" | "branch gone" | "repo gone" | "closed PR" | "open PR" | "dirty, N files" | "cwd of open session <key>" | "unmerged work"
  };
  export type Action = "review" | "prune" | "name" | "-";
  export type WorksetSummary = {
    name: string; named: boolean; members: MemberStatus[];
    prMix: Record<PrState, number>; dirty: number;
    sessions: { open: number; stale: number; closed: number; last: string | null };
    action: Action;
  };
  export const isNamed = (name: string) => !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name);
  export type TriageDeps = { prs?: typeof gh.prsForBranches; nowMs?: number };
  export function memberStatuses(ws: Workset, deps?: TriageDeps): MemberStatus[];   // one prsForBranches call per distinct slug across the workset
  export function summarize(ws: Workset, deps?: TriageDeps): WorksetSummary;
  export function summarizeAll(deps?: TriageDeps): WorksetSummary[];                 // every workset, sorted: action order review, prune, name, -; then sessions.last desc
  export function refreshStoredPr(ws: Workset, statuses: MemberStatus[]): boolean;   // updates m.pr and, for members with a PR, m.base/m.base_source="pr" from prBase; returns whether anything changed (caller saves)
  ```
- Action rules (decision 10), first match: `review` if `loadLock(ws.name)` or any bound session has `unreadCount > 0`; `prune` if every member is prunable (an empty default workset with no open pointer counts as prune); `name` if `!named` and any member has `pr === "open"` or `unpushed` or `dirty > 0`; else `-`.

- [ ] **Step 1: Write the failing tests**

Fixture: two repos via `mkRepo` with an `origin`; branches `merged` (pushed, then stubbed `MERGED`), `closed` (stubbed `CLOSED`), `open` (stubbed `OPEN`), `gone-up` (pushed, remote branch deleted with `git push origin :gone-up`, `git fetch -p`), `local-only` (one commit, no upstream), `dirty` (worktree with an untracked file, stubbed `MERGED`). Stub via `WORKBENCH_GH_STUB` with key `prsForBranches`.

Tests:
- `memberStatuses` classifies: `merged` → prunable `merged`; `closed` → not prunable `closed PR`; `open` → not prunable `open PR`; `gone-up` → prunable `remote-gone`; `local-only` → not prunable `unmerged work`, `unpushed` true; `dirty` → not prunable `dirty, 1 files`; a member whose branch was deleted → prunable `branch gone`, `branchExists` false; a member with `repo: join(tmp, "nope")` → prunable `repo gone` and no throw (Review Focus 1); a member in a repo created with `mkRepo(name, false)` (no origin, slug null) classifies by git only and the `prs` dep is never called for `null` slug (Review Focus 2).
- `cwdOf`: write a pointer `{harness:"claude", session:"s1", cwd:<worktree of merged>, closed:null}` with a fresh transcript under `WORKBENCH_CLAUDE_PROJECTS`; `merged` becomes not prunable with reason `cwd of open session claude-s1`.
- `summarize` action: all-prunable default workset → `prune`; default workset with `open` member → `name`; same members in a workset named `cinf-1` → `-`; a lock file written via `writeJson(sub("locks")/<name>.json)` → `review`; unread inbox review for a bound session → `review`; empty default workset with no pointer → `prune`; empty default workset with an open pointer → `-`.
- `summarize.sessions`: pointers open (live transcript), stale (old transcript), closed → `{open:1, stale:1, closed:1}` and `last` is the max of `closed`/`opened`/transcript mtime as ISO.
- `summarizeAll` ordering: three worksets with actions `-`, `prune`, `review` come back `review, prune, -`.
- `refreshStoredPr`: a member stored with `pr: null` and `base: "feature-below"` whose stub says `OPEN` with base `main` ends with `pr.state === "OPEN"`, `base === "main"`, `base_source === "pr"`, return true; unchanged input returns false.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/triage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/triage.ts`** per the Interfaces block. `unpushed`: if `git for-each-ref --format=%(upstream:track)` is non-empty and not `[gone]`, parse `ahead N`; if no upstream, `git rev-list --count <diffBase(m, config)>..<branch>` > 0. Add `git.aheadOfUpstream(repo, branch): number | null` and `git.revListCount(repo, range): number | null` to `git.ts` if the existing helpers do not cover it.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test test/triage.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src/triage.ts local/lib/workbench/src/git.ts local/lib/workbench/test/triage.test.ts
git commit -m "workbench: member status and workset summary for triage"
```

---

### Task 4: `workset list` overview

**Files:**
- Modify: `local/lib/workbench/src/cmd/workset.ts` (`list` case, `USAGE`), `local/lib/workbench/README.md` (command table row for `list`)
- Test: `local/lib/workbench/test/derive.test.ts` (extend with the `capture` helper already there) or a new `test/list.test.ts` reusing `capture`

**Interfaces:**
- Consumes: `summarizeAll`, `refreshStoredPr` (Task 3), `derive`, `unclaimed` (existing).
- Produces: `workbench workset list [--json]`. Table columns in order: `action`, `name`, `kind` (`named`/`default`), `members`, `pr` (`Mm Cc Oo Nn`, e.g. `3m 0c 1o 2n`), `dirty`, `sessions` (`1 open / 2 stale / 3 closed`), `last` (ISO date, `-` when none). Footer: blank line, then `unclaimed per repo:` and one line `<slug or repo>  <count>` per repo with a non-zero count, derived with `unclaimed(derive(config), worksets)` grouped by `repo`. `--json` prints `{ worksets: WorksetSummary[], unclaimed: Record<string, number> }`. When `gh.lastGhError` is set after summarizing, print `gh not available: PR state from stored members` on stderr. Side effect: for each workset where `refreshStoredPr` returns true, `saveWorkset`.

- [ ] **Step 1: Write the failing tests**

- `list prints one row per workset in action order with the pr mix`: two worksets from the Task 3 fixture; assert the first data row begins with `prune` and contains `1m 0c 0o 0n` style counts, the `kind` column reads `default`/`named` correctly, and `unclaimed per repo:` appears with the fixture's unclaimed branch count.
- `list --json shape`: parse stdout; `worksets[0].action`, `unclaimed` keys.
- `list refreshes stored pr`: after `list`, `loadWorkset(name).members[0].pr.state` equals the stub's state.
- The existing `list` test (if any asserts plain names) is updated to the table.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/derive.test.ts`
Expected: FAIL (list prints bare names).

- [ ] **Step 3: Implement** the `list` case with the existing `table()` helper; update `USAGE` (`list [--json]`) and the README row to: ``| `workbench workset list [--json]` | Overview: one row per workset with PR mix, dirty worktrees, session state and a suggested action (`review`, `prune`, `name`); unclaimed count per repo below. |``.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test && bun run check`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src/cmd/workset.ts local/lib/workbench/README.md local/lib/workbench/test
git commit -m "workbench: workset list is a per-workset overview with a suggested action"
```

---

### Task 5: `workset prune` on worksets

**Files:**
- Create: `local/lib/workbench/src/prune.ts`
- Modify: `local/lib/workbench/src/cmd/workset.ts` (replace the `prune` case; `USAGE`), `local/lib/workbench/src/inbox.ts` (export `removeInbox(key)` and `removePidFile(key)`), `local/lib/workbench/README.md` (prune row), `local/lib/workbench/CONTEXT.md` (add *stale*, *named*, *prunable member*)
- Test: `local/lib/workbench/test/prune.test.ts` (new), `local/lib/workbench/test/derive.test.ts` (delete the `prune <id>` tests at lines ~175–200)

**Interfaces:**
- Consumes: `memberStatuses`, `summarize`, `isNamed` (Task 3), `pointerState`, `closeStale` (Task 2), `git.pruneWorktreeAndBranch`, `review.loadLock`, `review.clearNotes`, `session.listPointers`, `workset.removeMember`/`deleteWorkset`/`saveWorkset`.
- Produces:
  ```ts
  export type PrunePlan = {
    workset: string; refused: string | null;                    // "locked" when a lock exists
    members: { status: MemberStatus; cmds: string[] }[];        // prunable members; cmds is the git commands or [] for already-gone
    kept: MemberStatus[];                                       // not prunable, with reason
    rebase: { member: Member; from: string; to: string }[];     // base rewrites for remaining members
    deleteWorkset: boolean; keepReason: string | null;          // "members remain" | "open session <key>"
    pointers: { close: Pointer[]; delete: Pointer[] };          // stale → closed; closed-and-bound-only-here → deleted
  };
  export function planPrune(ws: Workset, deps?: TriageDeps): PrunePlan;
  export function executePrune(plan: PrunePlan, log: (line: string) => void): boolean;  // false if any git step failed; continues past failures
  export function sweepable(deps?: TriageDeps): PrunePlan[];     // plans for default-named worksets whose every member is prunable, excluding refused
  export function renderPlan(plan: PrunePlan): string;          // the dry-run text
  ```
- Rebase rule (decision 14): for each remaining member `r` with `r.base === pruned.branch` in the same repo: `to = statusOf(r).prBase ?? pruned.base ?? config.default_branch`, `base_source` becomes `"pr"` when from prBase else unchanged.
- Pointer rule: a pointer is bound to the workset when `p.workset === ws.name` or `ws.sessions.includes(p.key)`. Stale → `close` list; closed (or stale, after closing) and not bound to any other workset → `delete` list; if any pointer is `open`, `deleteWorkset = false`, `keepReason = "open session <key>"`.
- Deletion of a workset: `clearNotes(name)`, `deleteWorkset(name)`, and for each pointer in `delete`: `removeInbox(key)`, `removePidFile(key)`, `removeFile(sessions/<key>.json)`. Archives untouched.
- Duplicate worktree paths (Review Focus 4): `executePrune` dedupes `git worktree remove` by path across the plan's members and skips a `branch -D` whose branch is already gone.

- [ ] **Step 1: Write the failing tests**

Fixture as in Task 3 plus a stacked workset: members `s1` (based on main, stubbed `MERGED`), `s2` (`base: "s1"`, `base_source: "inferred"`, stubbed `OPEN` with `baseRefName: "main"`), `s3` (`base: "s2"`, no PR, unmerged).

- `planPrune on a mixed workset`: `members` has `s1` only; `kept` has `s2` (`open PR`) and `s3` (`unmerged work`); `rebase` is `[{member: s2, from: "s1", to: "main"}]`; `deleteWorkset` false, `keepReason` `members remain`.
- `executePrune mixed`: `s1` branch and worktree gone, `s2.base === "main"`, `s2.base_source === "pr"`, workset still exists with 2 members.
- `rebase without PR collapses the chain`: `s2` stubbed with no PR and `s1.base = "main"`; after pruning `s1`, `s2.base === "main"` and `base_source` unchanged.
- `planPrune all-dead default workset`: `deleteWorkset` true; after `executePrune`, `loadWorkset` is null, `reviews/<name>/notes` gone, `reviews/<name>/<id>.json` archive (pre-written) still present.
- `pointers`: bound pointers one open (live transcript), one stale, one closed. Plan has `pointers.close = [stale]`, `pointers.delete = [stale, closed]`, `deleteWorkset` false, `keepReason` `open session <key>`. With the open one removed: `deleteWorkset` true and after execution the two pointer files, `inbox/<key>/` dirs and `watch/<key>.pid` files are gone; the closed pointer's `closed_reason` absent, the stale one's is `"stale"` (assert before deletion by reading the plan's `close` entries after `executePrune` ran `closeStale`).
- `pointer bound to two worksets is kept`: closed pointer with `workset: other` but listed in `ws.sessions` → not in `delete`.
- `refused when locked`: write `locks/<name>.json`; `planPrune().refused === "locked"`; `executePrune` returns false without running git.
- `sweepable`: default all-dead → included; named all-dead → excluded; default mixed → excluded; default empty with no pointers → included; default empty with an open pointer → excluded.
- `duplicate worktree path`: two members sharing one worktree, both prunable; `executePrune` returns true and the dir is removed once (Review Focus 4).
- Command tests via `capture(() => worksetRun([...]))`: `prune` with no args prints each sweepable plan and changes nothing; `prune --yes` executes all sweepable; `prune <name>` dry run prints `would run in <repo>:` lines and `kept:` lines; `prune <name> --yes` executes; `prune <name>` on a named workset works (named is excluded from the sweep only); `prune <id-with-#>` now fails with `no workset "<id>"` exit 1.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/prune.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/prune.ts`**, the `inbox.ts` exports, the new `prune` case (`prune [<name>] [--yes]`), `USAGE`, README row ``| `workbench workset prune [<name>] [--yes]` | Prune dead members (merged, upstream gone, branch gone) of a workset and delete it once empty; with no name, sweep every default-named workset whose members are all dead. Dry run without `--yes`. |``, CONTEXT.md glossary entries. Delete the `prune <id>` tests from `derive.test.ts`. `derive.prunable` stays for `scan`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test && bun run check`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench
git commit -m "workbench: workset prune operates on worksets; sweep dead default worksets"
```

---

### Task 6: `workset rename`

**Files:**
- Modify: `local/lib/workbench/src/workset.ts` (`renameWorkset`), `local/lib/workbench/src/cmd/workset.ts` (`rename` case, `USAGE`), `local/lib/workbench/README.md` (row)
- Test: `local/lib/workbench/test/workset.test.ts` (extend), `local/lib/workbench/test/derive.test.ts` or `test/prune.test.ts` for the command

**Interfaces:**
- Consumes: `review.loadLock`, `session.listPointers`/`savePointer`, `inbox` review files (`ReviewFile.workset`), `paths.sub`.
- Produces: `export function renameWorkset(from: string, to: string): void` in `workset.ts`. Throws `workbench: no workset "<from>"`, `workbench: workset "<to>" exists`, `workbench: invalid workset name "<to>"` (reuse `NAME`), `workbench: "<from>" has an open review; close or submit it first` when `loadLock(from)`. Otherwise: rewrite `worksets/<from>.json` → `<to>.json` with `name: to`; every pointer with `workset === from` → `to`; `reviews/<from>/` directory → `reviews/<to>/` (archives and notes) when present; every `inbox/*/<id>.json` with `workset === from` rewritten with `to`. Command: `workbench workset rename <old> <new>`, exit 1 with the message on any throw.

- [ ] **Step 1: Write the failing tests**

- rename moves the file, sets `name`, updates two pointers, moves `reviews/<from>/x.json` to `reviews/<to>/x.json`, rewrites an inbox file's `workset`; `loadWorkset(from)` is null afterwards.
- refuses when `to` exists; when `to` is invalid; when `from` is locked (lock file still present afterwards, nothing moved).
- command: `rename a b` exit 0 prints `a -> b`; `rename a` exit 2 usage.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/workset.test.ts`
Expected: FAIL, `renameWorkset is not exported`.

- [ ] **Step 3: Implement** per Interfaces; README row ``| `workbench workset rename <old> <new>` | Rename a workset (naming is the pin: named worksets are never swept by `prune`). Refused while a review is open. |``.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench
git commit -m "workbench: workset rename; naming is the pin"
```

---

### Task 7: Acceptance against live state

**Files:** none changed; this task verifies.

- [ ] **Step 1:** `workbench workset list`. Expected: 13 rows (as of 2026-10-19), `cinf-794-dev` and `cinf-794-03-layered` shown `named`; the two 2026-10-13/14 default worksets with empty members and never-closed pointers show `1 stale` and action `prune`; the current session's workset shows `1 open`; no row errors; `unclaimed per repo:` lists infrastructure, product-services, k8s-manifests.
- [ ] **Step 2:** `workbench workset prune`. Expected: the plan lists only default-named worksets whose members are all merged, remote-gone, gone or absent; nothing is deleted (confirm `ls ~/.local/state/workbench/worksets | wc -l` unchanged).
- [ ] **Step 3:** `workbench workset prune <one all-dead default workset> --yes` chosen by the owner. Expected: its branches and worktrees gone, workset file gone, archives kept, `bun test` still green. No commit; paste the before and after of `workbench workset list` into the PR or handoff note.
