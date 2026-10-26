# Workbench Watching Mode and Thread Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The review window outlives the review (watching vs reviewing), deletions in hunk reach the notes snapshot, and the reviewer closes a thread with a `/resolve` reply.

**Architecture:** The open-review file is split into a window file (hunk pane and session bookkeeping, plus two per-hunk-session maps: live note ids and note-to-thread) and a review file (id, snapshot, lock). Submit and close drop the review and leave the window. A new notes module snapshots the current member on every sidebar tick, detects deleted notes against the live set, and hands threaded `/resolve` replies to a resolution module that marks the archived comment, queues the id for the next review file and removes the thread's notes from hunk.

**Tech Stack:** TypeScript on Bun, `bun test`, hunk 0.24 `session comment` CLI, tmux. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-workbench-watching-and-resolution-design.md`

## Global Constraints

- Code lives in `local/lib/workbench/`; run tests with `cd local/lib/workbench && bun test` and types with `bun run check`. `./script/test` at the repo root must still pass.
- The hook (`src/hook.ts`, `src/lock.ts`, `src/harness/claude.ts`) does not change. The lock file format does not change.
- State files: `windows/<ws>.json` (new), `reviews/<ws>.json` (review only), `reviews/<ws>/notes/<member>.json`, `reviews/<ws>/<review id>.json`, `reviews/<ws>/resolved-pending.json` (new), `inbox/<key>/<review id>.json`, `locks/<ws>.json`.
- Exact copy from the spec: sidebar key line `j/k move  ⏎ show  t throwaways  r review  s submit  c close (asks for yes)  q quit`; header `<ws>  watching` / `<ws>  reviewing <review id>`; status lines `a review is already open`, `no review to submit; press r`, `nothing to close`, `cannot resolve: unknown thread`; guard message `lock first: press r in the sidebar`; refusal `review window open; quit it first`; resolved render line `- ~~resolved~~ **<type>** \`<path>:<lines>\` (id \`<id>\`) — <text> — closed: <closing text>`; session line `<key>  open|closed  inbox: <n> unread  threads <open> open / <total>`; reply CLI suffix `(thread resolved)`.
- Hunk listing for snapshots uses `--type all`. Resolution writes go through `updateReviewFile` so concurrent agent replies survive.
- Markdown files in this repo are not hard-wrapped.
- Commit after each task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A stale window file whose tmux session is gone must not block `rename`, `prune` or `delete`, and `open` must rebuild it rather than trust its pane ids. Test in Task 1 (`windowOpen`) and Task 2 (rebuild on missing session).
2. A hunk restart mid-session (new hunk session id) must not count every earlier note as deleted. Test in Task 8 (session-id change resets the live set).
3. A `/resolve` typed under a note that workbench did not add, or under a reply from a review of another member, must leave the note on screen and warn, never resolve the wrong thread. Test in Task 9 (unknown parent).
4. An agent reply arriving after the thread was resolved must be kept in the files and not shown, and `workbench reply` must say so. Test in Task 9.
5. Submit while watching from the shell (`workbench submit` with no review open) must fail with today's message and touch nothing; `r` on a worktree whose branch is not checked out must leave the window up and report in the status line. Tests in Task 3 and Task 4.

---

### Task 1: Window state module

**Files:**
- Create: `src/window.ts`
- Test: `test/window.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Window = {
    workset: string; hunkPaneId: string | null; hunkSessionId: string | null; hunkPaneCwd: string | null; current: string | null;
    live: Record<string, Record<string, string | null>>; // member id → note id → original note id for a proxy, null for an own note
    threads: Record<string, string>;                      // note id → archived comment id, for this hunk session
    commands?: string[];                                  // dry-run argv log, as Review.commands today
  };
  export const windowFile: (ws: string) => string;        // join(sub("windows"), `${ws}.json`)
  export const loadWindow: (ws: string) => Window | null;
  export function saveWindow(w: Window): void;            // appends drainRecorded() to commands in a dry run, like saveReview
  export const removeWindow: (ws: string) => void;
  export const newWindow: (ws: string) => Window;         // nulls, empty maps
  export function setHunkSession(w: Window, sid: string | null): void; // when sid !== w.hunkSessionId: set it and reset live and threads to {}
  export function windowOpen(ws: string): boolean;        // loadWindow(ws) !== null && tmux.hasSession(tmux.sessionName(ws))
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("setHunkSession resets live and threads only when the id changes", () => {
  const w = newWindow("ws1"); w.live = { m: { "user:1": null } }; w.threads = { "mcp:1": "user:9" }; w.hunkSessionId = "a";
  setHunkSession(w, "a"); expect(w.live).toEqual({ m: { "user:1": null } });
  setHunkSession(w, "b"); expect(w).toMatchObject({ hunkSessionId: "b", live: {}, threads: {} });
});
test("windowOpen needs both the file and the tmux session", () => {
  expect(windowOpen("ws1")).toBe(false);
  saveWindow(newWindow("ws1"));
  expect(windowOpen("ws1")).toBe(false);                     // WORKBENCH_DRY_RUN_TMUX has no wb-ws1
  process.env.WORKBENCH_DRY_RUN_TMUX = JSON.stringify({ sessions: { "wb-ws1": { panes: [] } } });
  expect(windowOpen("ws1")).toBe(true);
});
test("saveWindow round-trips and removeWindow deletes", () => { ... loadWindow equals saved; after removeWindow, null });
```

Use the `beforeEach`/`afterEach` state-dir and env pattern from `test/review-open.test.ts` with `WORKBENCH_DRY_RUN=1`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/window.test.ts`
Expected: FAIL, module `../src/window` not found.

- [ ] **Step 3: Implement `src/window.ts`** with the interface above, using `readJson`, `writeJson`, `removeFile` from `./store`, `sub` from `./paths`, `dryRun`/`drainRecorded` from `./spawn`, `hasSession`/`sessionName` from `./tmux`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/window.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src/window.ts local/lib/workbench/test/window.test.ts
git commit -m "workbench: window state file"
```

---

### Task 2: Split the review into window and review; open without locking

**Files:**
- Modify: `src/review.ts` (whole file: lines 15-255)
- Modify: `src/window.ts` (add the window-management functions moved from review.ts)
- Modify: `src/reply.ts:53-90`, `src/submit.ts:44-49,73-78`, `src/sidebar.ts:22-27,43-51`
- Test: `test/review-open.test.ts`, `test/reply.test.ts`, `test/submit.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // src/review.ts
  export type Review = { id: string; workset: string; opened: string; snapshot: Record<string, { tip: string; dirty: string[] }>; locked: string[] };
  export type Opened = { window: Window; review: Review | null };
  export function openReview(name: string, opts: { allowDirty: boolean; review?: boolean }): Opened; // ensures the window; starts a review only with opts.review or when one is already open
  export function startReview(name: string, opts: { allowDirty: boolean }): Review; // today's review half of openReview: refuses dirty/wrong branch, snapshots, writes lock and review file; throws "a review is already open" if one exists
  export function saveReview(r: Review): void;        // plain writeJson; commands live on the window now
  export function reconcileIds(r: Review | null, w: Window, ws: Workset): boolean; // re-keys r.snapshot, notes files and w.current
  // unchanged exports: loadReview, loadLock, loadNotes, clearNotes, releaseReview, hasWorktree, diffRef, archiveFile, config
  // removed: killWindow, hunkTarget(Review), snapshotNotes(Review), repoint(Review)
  // src/window.ts (moved from review.ts, Review → Window)
  export const hunkTarget: (w: Window, m: Member) => hunk.Target;
  export function snapshotNotes(w: Window, m: Member): hunk.RawNote[];  // replaced by notes.syncMember in Task 8; keep the merge-only behaviour for now
  export function repoint(w: Window, ws: Workset, to: Member, base: string): boolean;
  export function ensureWindow(name: string, ws: Workset, cfg: Config): Window; // today's openWindow: builds or repairs the tmux session, adopts a live hunk, saves and returns the window; rebuilds from newWindow when the tmux session is gone
  ```

- [ ] **Step 1: Update the tests to the new shapes**

In `test/review-open.test.ts`: `openReview(...)` now returns `Opened`; replace `r.commands` with `r.window.commands`, `r.hunkPaneId` with `r.window.hunkPaneId`, `loadReview("ws1")!.commands` with `loadWindow("ws1")!.commands`, `repoint(review, ...)` with `repoint(window, ...)`. Change the lock-and-snapshot tests to pass `{ allowDirty, review: true }` and add:

```ts
test("open without --review builds the window and takes no lock", () => {
  const wt = worktree("feat"); workset([{ branch: "feat", worktree: wt }]);
  const o = openReview("ws1", { allowDirty: false });
  expect(o.review).toBeNull(); expect(loadReview("ws1")).toBeNull(); expect(loadLock("ws1")).toBeNull();
  expect(loadWindow("ws1")).toMatchObject({ hunkPaneId: "%1", current: `${repo}#feat` });
});
test("open on a dirty worktree still opens the window; only startReview refuses", () => { ... writeFileSync scratch; openReview ok; expect(() => startReview("ws1", { allowDirty: false })).toThrow("scratch.txt") });
test("startReview twice throws 'a review is already open'", ...);
test("startReview on a worktree with another branch checked out throws and leaves the window file", () => { ... sh(wt, "checkout", "-q", "main"); openReview("ws1", { allowDirty: false }); expect(() => startReview("ws1", { allowDirty: false })).toThrow("checked out"); expect(loadWindow("ws1")).not.toBeNull(); expect(loadLock("ws1")).toBeNull(); });
test("open with a window file whose tmux session is gone rebuilds it", () => { saveWindow({ ...newWindow("ws1"), hunkPaneId: "%9", hunkSessionId: "dead" }); // WORKBENCH_DRY_RUN_TMUX has no wb-ws1
  const o = openReview("ws1", { allowDirty: false }); expect(o.window.hunkPaneId).toBe("%1"); expect(o.window.commands).toContain(expect.stringContaining("tmux new-session")) });
```

In `test/reply.test.ts`: `openFile`/`putOpen` write a `Window` to `state/windows/ws1.json` (fields `workset, hunkPaneId, hunkSessionId, hunkPaneCwd, current, live: {}, threads: {}`) instead of a Review; `rehydrateReplies(window, member)`.

In `test/submit.test.ts`: tests that read `review.current` or hunk fields read the window.

- [ ] **Step 2: Run the three test files to verify they fail**

Run: `bun test test/review-open.test.ts test/reply.test.ts test/submit.test.ts`
Expected: FAIL on missing exports and shapes.

- [ ] **Step 3: Implement the split**

Move `hunkTarget`, `snapshotNotes`, `reshowOwnNotes`, `startHunk`, `repoint`, `adoptHunk`, `openWindow` (renamed `ensureWindow`) into `src/window.ts`, changing `Review` parameters to `Window` and `saveReview` calls to `saveWindow`. `startHunk` and `adoptHunk` call `setHunkSession(w, hunk.waitForSession(pane))`. `ensureWindow` loads the window; if the tmux session is missing it starts from `newWindow(name)`. In `review.ts`, `openReview` becomes: load workset, `const w = ensureWindow(name, ws, cfg)`, `let review = loadReview(name)`, `if (review) reconcileIds(review, w, ws) && saveReview(review)`, `if (!review && opts.review) review = startReview(name, opts)`, return `{ window: w, review }`. `startReview` is today's lines 640-661 plus the `loadReview` guard, and leaves `current` to the window. `reply.ts`: `addReply` reads `loadWindow(read.workset)` for `current` and `hunkSessionId`; `rehydrateReplies(w: Window, member)`. `submit.ts`: `snapshotCurrent` uses the window's `current`; `open()` also loads the window (may be null when the window was quit; then skip the snapshot). `sidebar.ts`: `current` comes from `loadWindow(name)`; `show()` requires a window, not a review, and calls `repoint(window, ...)`; the "no open review" status becomes `no window; run workbench open ${name}`.

- [ ] **Step 4: Run the full suite and type check**

Run: `bun test && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src local/lib/workbench/test
git commit -m "workbench: split the review window from the review; open no longer locks"
```

---

### Task 3: Submit and close return the window to watching

**Files:**
- Modify: `src/submit.ts:17-21,117-124,138-153`, `src/sidebar-review.ts:17-21,24-26`, `src/sidebar.ts:62-74`
- Test: `test/submit.test.ts:278-294`

**Interfaces:**
- Consumes: Task 2.
- Produces: `SubmitOptions` loses `beforeKill`; `submitReview` neither kills the window nor restarts hunk; `submitInPane(name): Promise<boolean>` prints the summary, pauses on a key and returns true, and the sidebar stays running after it.

- [ ] **Step 1: Rewrite the kill test**

Replace the test at `test/submit.test.ts:278` with:

```ts
test("submit leaves the window and its hunk session in place and releases the lock", async () => {
  ... open with review, window has hunkSessionId "sid-1" ...
  await submitReview("ws1", { message: "m", log });
  expect(drainRecorded().some((c) => c.includes("kill-session") || c.includes("respawn-pane"))).toBe(false);
  expect(loadWindow("ws1")!.hunkSessionId).toBe("sid-1");
  expect(loadReview("ws1")).toBeNull(); expect(loadLock("ws1")).toBeNull();
});
test("submit from the shell with no review open fails with today's message and writes nothing", async () => {
  openReview("ws1", { allowDirty: false });
  await expect(submitReview("ws1", { message: "m", log })).rejects.toThrow('no open review for "ws1"');
  expect(loadWindow("ws1")).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/submit.test.ts`
Expected: FAIL (kill-session recorded; `beforeKill` type error).

- [ ] **Step 3: Implement**

Remove `beforeKill` and the `killWindow` call from `submitReview`; delete `killWindow` from `review.ts`. The pause that goes is the pre-kill hook; the sidebar still waits for a key after printing the summary so it can be read before the next repaint (a refinement of spec decision 5). In `sidebar-review.ts`, `submitInPane` becomes: `takeOver(); try { await submitReview(name); } catch (e) { console.log(msg); } await anyKey(); return true;` (false only on error). Drop the sentence "comments live only in hunk's memory until the next open" from `CLOSE_WARNING`, leaving `Close the review without submitting? The lock is released and the window stays up.` In `sidebar.ts`, `reviewAction` no longer calls `quit()` after submit; both keys return to raw mode and `render()`.

- [ ] **Step 4: Run the suite**

Run: `bun test && bun run check`
Expected: PASS (update the `CLOSE_WARNING` assertion in the sidebar close test).

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src local/lib/workbench/test
git commit -m "workbench: submit and close return the window to watching"
```

---

### Task 4: Sidebar modes, the `r` key and `open --review`

**Files:**
- Modify: `src/sidebar-model.ts`, `src/sidebar.ts:9,18-28,62-74,76-88`, `src/cmd/open.ts`
- Test: `test/sidebar-model.test.ts`

**Interfaces:**
- Consumes: `startReview` from Task 2.
- Produces:
  ```ts
  // src/sidebar-model.ts
  export const KEYS = "j/k move  ⏎ show  t throwaways  r review  s submit  c close (asks for yes)  q quit";
  export function headerLine(name: string, reviewId: string | null): string; // `${name}  watching` | `${name}  reviewing ${reviewId}`
  export const STATUS = { alreadyOpen: "a review is already open", nothingToSubmit: "no review to submit; press r", nothingToClose: "nothing to close" } as const;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("header shows the mode", () => {
  expect(headerLine("ws1", null)).toBe("ws1  watching");
  expect(headerLine("ws1", "r-1")).toBe("ws1  reviewing r-1");
});
test("the key line names r", () => { expect(KEYS).toContain("r review"); });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/sidebar-model.test.ts`
Expected: FAIL, `headerLine` not exported.

- [ ] **Step 3: Implement**

`sidebar.ts`: import `KEYS`, `headerLine`, `STATUS`; header uses `headerLine(name, review?.id ?? null)`. `onKey`: `case "r"`: if `loadReview(name)` then `status = STATUS.alreadyOpen` else `try { startReview(name, { allowDirty: false }); status = \`review ${id} open\`; } catch (e) { status = e.message }`; `case "s"` when no review: `status = STATUS.nothingToSubmit` and `render()` without taking over the pane; `case "c"` when no review: `status = STATUS.nothingToClose`. Note the hunk `--watch` diff does not change on `r`, so no repoint. `cmd/open.ts`: add `review: { type: "boolean" }` to `parseArgs`, pass `review: !!values.review`, usage `workbench open <workset> [--review] [--allow-dirty] [--no-attach]`; print `${review?.id ?? "watching"} ${session}` under `--no-attach`.

- [ ] **Step 4: Run the suite**

Run: `bun test && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src local/lib/workbench/test
git commit -m "workbench: sidebar shows watching or reviewing; r starts a review; open --review"
```

---

### Task 5: Refusals keyed on the window

**Files:**
- Modify: `src/rename.ts:16`, `src/prune.ts:63`, `src/cmd/workset.ts:215-222`
- Test: `test/rename.test.ts`, `test/prune.test.ts`

**Interfaces:**
- Consumes: `windowOpen` from Task 1.
- Produces: `planPrune` returns `refusedPlan(ws, "review window open")` when `windowOpen(ws.name)`; `renameWorkset` throws `workbench: "<from>" has a review window open; quit it first`.

- [ ] **Step 1: Write the failing tests**

In `test/rename.test.ts`: `test("rename is refused while a review window is open", ...)` writing a window file and a dry-run tmux session `wb-<from>`, expecting the throw; and `test("a stale window file without a tmux session does not block rename", ...)`. In `test/prune.test.ts`: `test("prune refuses a workset with a review window open", ...)` expecting `plan.refused === "review window open"`; `test("prune of every workset reports a windowed one as refused without failing the run", ...)` through the `cmd/workset` prune path with `--yes`, expecting exit 0 and the plan rendered with the reason.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/rename.test.ts test/prune.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`rename.ts`: after the lock check add the window check. `prune.ts:63`: before the lock check, `if (windowOpen(ws.name)) return refusedPlan(ws, "review window open")`. `cmd/workset.ts` all-worksets prune loop (line 219 area): a plan refused with exactly `"review window open"` is printed but does not set `ok = false`.

- [ ] **Step 4: Run the suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add local/lib/workbench/src local/lib/workbench/test
git commit -m "workbench: rename and prune are refused while a review window is open"
```

---

### Task 6: Edit guard

**Files:**
- Create: `src/cmd/edit-guard.ts`, `local/bin/workbench-edit-guard` (shell, executable), `test/edit-guard.test.ts`
- Modify: `src/cli.ts` (add `"edit-guard"`), `src/hunk.ts:19-21` (`start`), `README.md` commands table (in Task 11)

**Interfaces:**
- Produces:
  ```ts
  // src/cmd/edit-guard.ts
  export const GUARD_MESSAGE = "lock first: press r in the sidebar";
  export function guard(ws: string, editor: string, args: string[], deps?: { exec?: (argv: string[]) => number; pause?: () => void }): number;
  // returns exec([...editor.split(" "), ...args]) when loadReview(ws) exists; otherwise prints GUARD_MESSAGE, calls pause(), returns 0
  export async function run(args: string[]): Promise<number>; // reads WORKBENCH_EDIT_WORKSET and WORKBENCH_EDIT_EDITOR, passes process.argv rest as args
  // src/hunk.ts
  export function start(pane: string, worktree: string, ref: string, paths: string[] = [], env: Record<string, string> = {}): boolean;
  // respawns ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "hunk", "diff", ref, "--watch", ...pathspec]
  ```
  `window.startHunk` passes `{ EDITOR: "workbench-edit-guard", WORKBENCH_EDIT_WORKSET: ws, WORKBENCH_EDIT_EDITOR: process.env.VISUAL || process.env.EDITOR || "nvim" }`.

  The shim `local/bin/workbench-edit-guard` is `#!/bin/sh` + `exec workbench edit-guard "$@"`, so `EDITOR` is a single word whatever hunk does with it. This refines the spec's `EDITOR=workbench edit-guard <ws> -- <editor>`: the workset and editor travel in env vars.

- [ ] **Step 1: Write the failing tests**

```ts
test("guard refuses without a review and execs with one", () => {
  const calls: string[][] = []; let paused = 0;
  const deps = { exec: (a: string[]) => { calls.push(a); return 0; }, pause: () => { paused++; } };
  expect(guard("ws1", "nvim -u NONE", ["+3", "f.txt"], deps)).toBe(0);
  expect(calls).toEqual([]); expect(paused).toBe(1);
  writeJson(join(tmp, "state", "reviews", "ws1.json"), { id: "r", workset: "ws1", opened: "t", snapshot: {}, locked: [] });
  guard("ws1", "nvim -u NONE", ["+3", "f.txt"], deps);
  expect(calls).toEqual([["nvim", "-u", "NONE", "+3", "f.txt"]]);
});
```

Add to `test/review-open.test.ts` dry-run command test: the respawn line is now `tmux respawn-pane -k -t %1 -c ${wt} env EDITOR=workbench-edit-guard WORKBENCH_EDIT_WORKSET=ws1 WORKBENCH_EDIT_EDITOR=${editor} hunk diff ${mb} --watch` (set `process.env.VISUAL = "nvim"` in `beforeEach` so `editor` is fixed).

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/edit-guard.test.ts test/review-open.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement** the three files and the `start` env parameter; `run` execs with `Bun.spawnSync(argv, { stdio: inherit })` and returns its exit code; `pause` reads one byte from stdin in raw mode. `chmod +x local/bin/workbench-edit-guard`.

- [ ] **Step 4: Run the suite and a manual check**

Run: `bun test && bun run check`
Expected: PASS
Run: `WORKBENCH_EDIT_WORKSET=nope WORKBENCH_EDIT_EDITOR=true ~/.dotfiles/local/bin/workbench-edit-guard x.txt </dev/null`
Expected: prints `lock first: press r in the sidebar`, exits 0.

- [ ] **Step 5: Commit**

```bash
git add local/bin/workbench-edit-guard local/lib/workbench/src local/lib/workbench/test
git commit -m "workbench: hunk edits are refused while watching"
```

---

### Task 7: hunk returns note ids; comment types and `/resolve` parsing

**Files:**
- Modify: `src/hunk.ts:63-69`, `src/comments.ts`
- Test: `test/comments.test.ts`, `test/hunk.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // src/hunk.ts
  export function addAgentComment(t: Target, note: AgentNote): string | null; // the new note's id from --json, null on failure. Dry runs return `dry:<n>` with a per-process counter.
  export function rmComment(t: Target, noteId: string): boolean;              // hunk session comment rm <addr> <id> --json
  // src/comments.ts
  export type Resolved = { at: string; by: string; text: string };
  export type Comment = { ...today; resolved?: Resolved };
  export type ThreadedReply = { id: string; parentId: string; body: string };
  export function threadedUserReplies(raw: unknown): ThreadedReply[];       // user notes with a parentId, from the list object or array
  export function parseResolve(body: string): { text: string } | null;      // body trimmed starts with "/resolve" followed by end or whitespace; text is the trimmed remainder
  ```
  `addAgentComment` finds the id as the first string-valued `noteId` at the top level of the parsed response or one level down (`comment`, `note`, `comments[0]`); the implementer verifies the real shape once by running `hunk session comment add --json` against a scratch `hunk diff` in a tmux pane and records the shape in a code comment.

- [ ] **Step 1: Write the failing tests**

```ts
test("parseResolve", () => {
  expect(parseResolve("/resolve")).toEqual({ text: "" });
  expect(parseResolve("  /resolve  done, thanks ")).toEqual({ text: "done, thanks" });
  expect(parseResolve("/resolved")).toBeNull(); expect(parseResolve("ok /resolve")).toBeNull();
});
test("threadedUserReplies keeps user notes with a parent only", () => {
  const raw = { comments: [{ noteId: "user:2", source: "user", parentId: "mcp:1", body: "/resolve", filePath: "f" }, { noteId: "user:1", source: "user", body: "x", filePath: "f" }, { noteId: "mcp:1", source: "agent", parentId: "user:1", body: "y", filePath: "f" }] };
  expect(threadedUserReplies(raw)).toEqual([{ id: "user:2", parentId: "mcp:1", body: "/resolve" }]);
});
test("addAgentComment returns the id hunk reports and rmComment records the command", () => {
  process.env.WORKBENCH_DRY_RUN = "1";
  expect(addAgentComment({ id: "s", path: "" }, { file: "f", newLine: 1, summary: "x" })).toMatch(/^dry:\d+$/);
  rmComment({ id: "s", path: "" }, "mcp:9");
  expect(drainRecorded()).toContain("hunk session comment rm s mcp:9 --json");
});
```

- [ ] **Step 2: Run to verify they fail**; **Step 3: Implement**; update existing callers of `addAgentComment` that test the boolean to `!== null` (`src/reply.ts:45,47`, `src/window.ts` reshowOwnNotes). **Step 4: `bun test && bun run check` PASS.**

- [ ] **Step 5: Commit**

```bash
git commit -am "workbench: hunk comment ids, resolved comment type, /resolve parser"
```

---

### Task 8: Notes sync with deletion tracking and the sidebar tick

**Files:**
- Create: `src/notes.ts`, `test/notes.test.ts`
- Modify: `src/window.ts` (replace `snapshotNotes`; `reshowOwnNotes` records proxies), `src/submit.ts` (`snapshotCurrent`), `src/sidebar.ts` (tick)

**Interfaces:**
- Consumes: `Window.live`, `setHunkSession` (Task 1); `hunk.allNotes`, `addAgentComment` id (Task 7); `threadedUserReplies` (Task 7).
- Produces:
  ```ts
  // src/notes.ts
  export type SyncResult = { notes: RawNote[]; replies: ThreadedReply[]; deleted: string[]; warnings: string[] }; // warnings is [] until Task 9 fills it
  export function applyDeletions(saved: RawNote[], prevLive: Record<string, string | null>, nowIds: Set<string>): { notes: RawNote[]; deleted: string[] };
  // pure: an id in prevLive absent from nowIds deletes prevLive[id] ?? id from saved
  export function syncMember(w: Window, m: Member): SyncResult;
  // 1. all = hunk.allNotes(hunkTarget(w, m)); nowIds = ids of all
  // 2. { notes, deleted } = applyDeletions(loadNotes(w.workset, m.id), w.live[m.id] ?? {}, nowIds)
  // 3. upsert top-level user notes from `all` into notes (merge by noteId, as today); write the notes file
  // 4. w.live[m.id] = { each top-level user note id → null, each previous proxy id still present → its original }
  // 5. replies = threadedUserReplies(all); saveWindow(w); return
  export function recordProxy(w: Window, memberId: string, proxyId: string, originalId: string): void; // w.live[memberId][proxyId] = originalId
  ```
  `reshowOwnNotes(w, m)` calls `recordProxy` with the id `addAgentComment` returns. `window.repoint`, `window.ensureWindow` (adopt path), `submit.snapshotCurrent` and `closeReview` call `syncMember` instead of `snapshotNotes`. `sidebar.ts`: the five-second `render` timer first runs `syncMember(window, currentMember)` when a window with a live hunk session and a current member with a worktree exists, catching errors into `status`; Task 9 adds the resolution step there.

- [ ] **Step 1: Write the failing tests**

```ts
test("applyDeletions drops a note that was live and is gone, and a proxy's original", () => {
  const saved = [note("user:1"), note("user:2"), note("user:3")];
  const r = applyDeletions(saved, { "user:1": null, "mcp:p2": "user:2", "user:3": null }, new Set(["user:3", "mcp:other"]));
  expect(r.notes.map((n) => n.noteId)).toEqual(["user:3"]); expect(r.deleted.sort()).toEqual(["user:1", "user:2"]);
});
test("applyDeletions with an empty live set deletes nothing", ...);
test("syncMember after a hunk session change deletes nothing and rebuilds live from what is on screen", () => {
  // window.hunkSessionId "a", live { m: { "user:1": null } }; notes file has user:1; setHunkSession(w, "b"); WORKBENCH_DRY_RUN_HUNK_NOTES = [] 
  // expect notes file still has user:1; w.live[m] = {}
});
test("syncMember keeps a proxy still on screen and returns threaded replies", () => {
  // live { m: { "mcp:p": "user:1" } }; hunk notes: agent mcp:p, user user:9 with parentId mcp:p body "/resolve"
  // expect w.live[m] = { "mcp:p": "user:1" }; replies = [{ id: "user:9", parentId: "mcp:p", body: "/resolve" }]; notes file unchanged
});
```

Also move the existing snapshot assertions in `test/review-open.test.ts` ("re-pointing ... snapshots notes") to expect `hunk session comment list <sid> --type all --json` instead of `--type user`.

- [ ] **Step 2: Run to verify they fail**; **Step 3: Implement** `src/notes.ts` and the call-site changes; delete `window.snapshotNotes`. **Step 4: `bun test && bun run check` PASS.**

- [ ] **Step 5: Commit**

```bash
git commit -am "workbench: notes sync tracks deletions in hunk and runs on the sidebar tick"
```

---

### Task 9: Resolution

**Files:**
- Create: `src/resolve.ts`, `test/resolve.test.ts`
- Modify: `src/reply.ts` (thread map writes, skip resolved), `src/cmd/reply.ts:17`, `src/notes.ts` (call `applyResolutions` from `syncMember`), `src/sidebar.ts` (warnings to status)

**Interfaces:**
- Consumes: `Window.threads` (Task 1), `rmComment`, `parseResolve`, `Resolved` (Task 7), `SyncResult` (Task 8), `updateReviewFile` (`src/reply.ts:16`).
- Produces:
  ```ts
  // src/resolve.ts
  export const pendingFile: (ws: string) => string; // join(sub("reviews"), ws, "resolved-pending.json"), a JSON string[]
  export function findArchived(ws: string, commentId: string): { reviewId: string; comment: Comment; sessions: string[] } | null; // scans listJson(join(sub("reviews"), ws)) archives
  export function resolveThread(w: Window, commentId: string, text: string, by = "you"): boolean;
  // false when findArchived is null. Else: updateReviewFile on the archive and each inbox copy setting comment.resolved = { at: now(), by, text } (no-op if already resolved);
  // append commentId to pendingFile (deduplicated); hunk.rmComment for every w.threads key mapping to commentId; delete those keys; saveWindow(w)
  export function applyResolutions(w: Window, m: Member, sync: SyncResult): string[]; // warnings
  // for each reply with parseResolve(body): target = w.threads[parentId] ?? (findArchived(ws, parentId) ? parentId : null)
  //   target → resolveThread(w, target, text) then rmComment(reply.id)
  //   else if parentId is an own note (in sync.notes, or a live proxy for one): remove it from the notes file, rmComment both, delete from w.live[m.id]
  //   else warnings.push("cannot resolve: unknown thread") and leave the reply on screen
  export function drainResolved(ws: string): string[]; // read, remove file, return ids
  // src/reply.ts
  export function recordThread(w: Window, noteId: string, commentId: string): void; // w.threads[noteId] = commentId; saveWindow
  // addReply: when c.resolved → append to files, do not show, return { reply, shown: false, resolved: true }
  // show(): after a successful addAgentComment, recordThread(w, id, c.id)
  // rehydrateReplies: skip comments with resolved
  ```
  `syncMember` ends with `result.warnings = applyResolutions(w, m, result)`; the sidebar tick sets `status` to the last warning.

- [ ] **Step 1: Write the failing tests**

```ts
test("/resolve under a shown reply resolves the archived comment in archive and inbox, queues the id, removes the thread's notes", () => {
  deliver(reviewFile("r1", [comment("user:1", { replies: [{ at: "t", by: "claude-a", text: "because" }] })]));
  const w = { ...window(), threads: { "mcp:7": "user:1" } }; saveWindow(w);
  liveNotes(agent("mcp:7"), threaded("user:9", "mcp:7", "/resolve fine"));
  const r = syncMember(w, member());
  expect(archiveCopy("r1").comments[0].resolved).toMatchObject({ by: "you", text: "fine" });
  expect(inboxCopy("r1").comments[0].resolved).toBeTruthy();
  expect(readJson(pendingFile("ws1"))).toEqual(["user:1"]);
  const rms = drainRecorded().filter((c) => c.startsWith("hunk session comment rm"));
  expect(rms).toEqual(["hunk session comment rm sid-1 mcp:7 --json", "hunk session comment rm sid-1 user:9 --json"]);
  expect(loadWindow("ws1")!.threads).toEqual({}); expect(r.warnings).toEqual([]);
});
test("/resolve directly under the original note (its id is the comment id) resolves too", ...);
test("/resolve under an unknown parent warns and removes nothing", () => { ... expect(r.warnings).toEqual(["cannot resolve: unknown thread"]); no rm recorded; no resolved });
test("/resolve under an own un-submitted note drops it like a delete", () => { ... notes file loses it; two rm commands });
test("rehydrateReplies skips a resolved comment and records the thread for shown ones", ...);
test("addReply to a resolved comment appends, does not show, and the CLI says (thread resolved)", async () => { ... expect(adds()).toEqual([]); expect(stdout).toContain("(thread resolved)") });
test("drainResolved returns the ids once and removes the file", ...);
```

- [ ] **Step 2: Run to verify they fail**; **Step 3: Implement**; **Step 4: `bun test && bun run check` PASS.**

- [ ] **Step 5: Commit**

```bash
git commit -am "workbench: /resolve closes a thread"
```

---

### Task 10: Delivery and rendering of resolved threads

**Files:**
- Modify: `src/submit.ts:13-16,113-116` (`ReviewFile.resolved`), `src/render.ts`, `src/cmd/inbox.ts:30-35`, `src/sidebar-model.ts:11-21`, `src/sidebar.ts:25`
- Test: `test/submit.test.ts`, `test/inbox.test.ts:22`, `test/sidebar-model.test.ts`

**Interfaces:**
- Consumes: `drainResolved`, `findArchived` (Task 9), `Resolved` (Task 7).
- Produces:
  ```ts
  // src/submit.ts
  export type ReviewFile = { ...today; resolved: string[] }; // drained at submit, after the comments are built and before delivery
  // src/render.ts
  export function renderMarkdown(r: ReviewFile, lookup: (id: string) => Comment | null = () => null): string;
  // a comment with resolved renders the single line from Global Constraints, replies omitted
  // when r.resolved is non-empty: "## Resolved" then one line per id: `- \`<id>\` (review <reviewId>) \`<path>:<lines>\` — <text>` from lookup, or `- \`<id>\` (not found)`
  // src/cmd/inbox.ts show: lookup = (id) => findArchived(r.workset, id)?.comment ?? null
  // src/sidebar-model.ts
  export type SessionView = { pointer: Pointer; reviews: { read: boolean; comments: { replies?: unknown[]; resolved?: unknown }[] }[] };
  export function sessionLine(s: SessionView): string; // `${key}  ${open|closed}  inbox: ${unread} unread  threads ${open} open / ${total}` where open = comments without resolved
  ```
  `findArchived` needs the review id in its result for the render line; Task 9's signature already carries it.

- [ ] **Step 1: Write the failing tests**

```ts
// submit.test.ts
test("submit drains pending resolutions into the review file and empties the queue", async () => { writeJson(pendingFile("ws1"), ["user:old"]); ... expect(file.resolved).toEqual(["user:old"]); expect(existsSync(pendingFile("ws1"))).toBe(false); });
// inbox.test.ts
test("render shows a resolved comment as one line without replies and lists resolved ids", () => {
  const md = renderMarkdown(review("rv1", { comments: [c({ resolved: { at: "t", by: "you", text: "fine" }, replies: [reply] })], resolved: ["user:old"] }), (id) => id === "user:old" ? c({ id, path: "a.ts", text: "older" }) : null);
  expect(md).toContain("- ~~resolved~~ **question** `src/x.ts:12-14` (id `user:1`) — why this? — closed: fine");
  expect(md).not.toContain("reply by"); expect(md).toContain("## Resolved"); expect(md).toContain("`user:old`"); expect(md).toContain("older");
});
// sidebar-model.test.ts: update sv() to accept resolved flags; expect "claude-1  open  inbox: 1 unread  threads 3 open / 5"
```

- [ ] **Step 2: Run to verify they fail**; **Step 3: Implement**; **Step 4: `bun test && bun run check` PASS.**

- [ ] **Step 5: Commit**

```bash
git commit -am "workbench: resolved threads reach the review file, inbox show and the sidebar"
```

---

### Task 11: Docs and the agent skill

**Files:**
- Modify: `local/lib/workbench/CONTEXT.md` (Review, Submit, Close, Review window entries; add Window, Watching, Resolution), `local/lib/workbench/README.md` (commands table lines 30-32, review flow lines 46-56, sidebar keys line 61-65, known limitations), `agents/skills/workbench-review/SKILL.md`, spec status line.

- [ ] **Step 1: CONTEXT.md.** Replace **Review window** with **Window**: "The tmux session `wb-<workset>` holding the sidebar and the reviewer. It outlives any one review." Add **Watching**: "A window with no review open: nothing is locked, the diff follows the agent's commits, replies show as they arrive, and comments typed in hunk wait as the next review's notes." Add **Reviewing** under **Review**'s avoid list as the other mode. Add **Resolution**: "The reviewer closing a thread with a `/resolve` reply in hunk. A resolved thread is not re-shown and needs nothing from the agent." Append "and returns the window to watching" to **Submit** and **Close**.
- [ ] **Step 2: README.md.** Commands table: `open <workset> [--review] [--allow-dirty] [--no-attach]` "Open the review window watching; `--review` also locks and starts a review"; `submit` no longer "kill the review window" but "return the window to watching"; add `workbench edit-guard` as "internal: hunk's `$EDITOR` while a window is up; refuses edits without a review". Review flow: step 1 opens watching, new step "Press `r` to start a review (lock, snapshot)", step 5 ends with the window returning to watching and replies streaming in, new step "Reply `/resolve [text]` under a thread to close it". Sidebar keys line from Global Constraints. Known limitations: replace the hunk-memory bullet with "hunk user notes live in the TUI's memory; the sidebar snapshots the current member's notes every five seconds, so a deletion or `/resolve` takes up to five seconds to take effect".
- [ ] **Step 3: SKILL.md.** After step 5 add: "6. A thread listed under **Resolved**, or rendered as ~~resolved~~, needs no reply and no work; a question you answered that then shows there is closed." Renumber the summary step.
- [ ] **Step 4: Spec status** line: `Implemented 2026-…` with the commit range.
- [ ] **Step 5: Run `./script/test` from the repo root; expect PASS. Commit.**

```bash
git add local/lib/workbench/CONTEXT.md local/lib/workbench/README.md agents/skills/workbench-review/SKILL.md docs/superpowers/specs/2026-10-26-workbench-watching-and-resolution-design.md
git commit -m "workbench: document watching mode and thread resolution"
```

---

### Task 12: Manual walkthrough on a scratch workset

Not a code task; the acceptance check before merging to `main`.

- [ ] Run `RCRC=~/.dotfiles/rcrc rcup` so the shim and skill link.
- [ ] Create a scratch repo and workset as in README's walkthrough; `workbench open scratch`: header says watching, no lock file, `workbench hook claude` prompt context has no lock line.
- [ ] Press `e` in hunk: the guard message appears, no editor. Press `r`: header says reviewing, lock file exists. `e` opens nvim.
- [ ] Leave a `?` comment, delete it with hunk's delete key, wait six seconds, confirm the notes file no longer has it. Leave another, press `s`, submit: the window stays, header says watching.
- [ ] In the bound Claude session, let it reply. The reply appears in hunk within seconds. Reply `/resolve ok` under it: both notes vanish, the archive has `resolved`, `resolved-pending.json` has the id. Press `r`, `s`: `inbox show` in the agent session lists the id under Resolved.
- [ ] `workbench workset rename scratch scratch2` is refused while the window is up; quit the tmux session; it succeeds.
