import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReview, loadReview, loadLock, loadNotes, repoint } from "../src/review";
import { existsSync } from "node:fs";
import { addMember, createWorkset, saveWorkset } from "../src/workset";

const ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

let tmp: string, repo: string;
const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN", "WORKBENCH_DRY_RUN_TMUX", "WORKBENCH_DRY_RUN_FAIL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-open-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_DRY_RUN = "1";
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
  repo = join(tmp, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), "a\n");
  sh(repo, "add", "f.txt");
  sh(repo, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function worktree(branch: string, base = "main"): string {
  const wt = join(tmp, `wt-${branch}`);
  sh(repo, "worktree", "add", "-q", "-b", branch, wt, base);
  writeFileSync(join(wt, `${branch}.txt`), `${branch}\n`);
  sh(wt, "add", ".");
  sh(wt, "commit", "-q", "-m", branch);
  return wt;
}

function workset(members: { branch: string; worktree: string | null; role?: "work" | "throwaway"; base?: string }[]) {
  const ws = createWorkset("ws1", "hand");
  for (const m of members) addMember(ws, { repo, branch: m.branch, worktree: m.worktree ?? undefined, role: m.role, base: m.base, added_by: "hand" });
  saveWorkset(ws);
  return ws;
}

test("open refuses a dirty work worktree and names the file", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  writeFileSync(join(wt, "scratch.txt"), "x\n");
  expect(() => openReview("ws1", { allowDirty: false })).toThrow(join(wt, "scratch.txt"));
  expect(loadReview("ws1")).toBeNull();
  expect(loadLock("ws1")).toBeNull();
});

test("open with allowDirty records the dirty files in the snapshot", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  writeFileSync(join(wt, "scratch.txt"), "x\n");
  writeFileSync(join(wt, "f.txt"), "changed\n");
  const r = openReview("ws1", { allowDirty: true });
  expect(r.snapshot[`${repo}#feat`].dirty.sort()).toEqual(["f.txt", "scratch.txt"]);
  expect(loadReview("ws1")!.id).toBe(r.id);
});

test("open snapshots each member tip sha and writes the lock with work worktrees only", () => {
  const work = worktree("feat");
  const junk = worktree("junk");
  workset([{ branch: "feat", worktree: work }, { branch: "junk", worktree: junk, role: "throwaway" }]);
  const r = openReview("ws1", { allowDirty: false });
  expect(r.id).toMatch(/^r-\d{8}-\d{6}-[0-9a-f]{4}$/);
  expect(r.snapshot[`${repo}#feat`]).toEqual({ tip: sh(work, "rev-parse", "HEAD"), dirty: [] });
  expect(r.snapshot[`${repo}#junk`].tip).toBe(sh(junk, "rev-parse", "HEAD"));
  expect(r.locked).toEqual([work]);
  expect(r.current).toBe(`${repo}#feat`);
  expect(r.hunkPaneCwd).toBe(work);
  const lock = loadLock("ws1")!;
  expect(lock).toMatchObject({ workset: "ws1", review: r.id, paths: [work], opened: r.opened });
  expect(typeof lock.holder).toBe("string");
});

test("reopening reuses the review and does not rewrite the lock", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  const first = openReview("ws1", { allowDirty: false });
  const lockFile = join(tmp, "state", "locks", "ws1.json");
  const before = statSync(lockFile).ino;
  writeFileSync(join(wt, "later.txt"), "x\n"); // dirt after opening does not matter on reuse
  const again = openReview("ws1", { allowDirty: false });
  expect(again.id).toBe(first.id);
  expect(again.snapshot).toEqual(first.snapshot);
  expect(statSync(lockFile).ino).toBe(before);
});

test("open refuses a workset with no work member that has a worktree", () => {
  const junk = worktree("junk");
  workset([{ branch: "feat", worktree: null }, { branch: "junk", worktree: junk, role: "throwaway" }]);
  expect(() => openReview("ws1", { allowDirty: false })).toThrow(/no work member with a worktree/);
  expect(loadReview("ws1")).toBeNull();
});

test("dry run records new-session, hunk diff against the merge base, then split-window", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  const r = openReview("ws1", { allowDirty: false });
  const cmds = r.commands!;
  const mb = sh(wt, "merge-base", "main", "feat");
  const at = (s: string) => cmds.findIndex((c) => c.startsWith(s));
  const ns = at("tmux new-session"), hd = at("tmux respawn-pane"), sw = at("tmux split-window");
  expect(cmds[ns]).toBe(`tmux new-session -d -s wb-ws1 -c ${wt} -x 220 -y 60 -P -F #{pane_id}`);
  expect(cmds[hd]).toBe(`tmux respawn-pane -k -t %1 -c ${wt} hunk diff ${mb} --watch`);
  expect(cmds[sw]).toBe(`tmux split-window -h -b -l 44 -c ${wt} -t %1 workbench sidebar ws1`);
  expect(ns).toBeGreaterThanOrEqual(0);
  expect(hd).toBeGreaterThan(ns);
  expect(sw).toBeGreaterThan(hd);
  expect(r.hunkPaneId).toBe("%1");
});

test("open refuses when git status fails in a work worktree", () => {
  const notGit = join(tmp, "not-a-repo");
  mkdirSync(notGit);
  workset([{ branch: "feat", worktree: notGit }]);
  expect(() => openReview("ws1", { allowDirty: true })).toThrow(`cannot read git status in ${notGit}`);
  expect(loadLock("ws1")).toBeNull();
});

const panes = (list: { id: string; dead?: boolean; start: string }[]) =>
  JSON.stringify({ sessions: { "wb-ws1": { panes: list } } });
const SIDEBAR = { id: "%2", start: '"workbench sidebar ws1"' };
function reopen(stub: string): string[] {
  const before = loadReview("ws1")!.commands!.length;
  process.env.WORKBENCH_DRY_RUN_TMUX = stub;
  return openReview("ws1", { allowDirty: false }).commands!.slice(before);
}
const acts = (cmds: string[]) => cmds.filter((c) => /new-session|split-window|respawn-pane|resize-pane/.test(c));

test("reopen leaves a healthy window untouched", () => {
  workset([{ branch: "feat", worktree: worktree("feat") }]);
  openReview("ws1", { allowDirty: false });
  expect(acts(reopen(panes([SIDEBAR, { id: "%1", start: '"hunk diff abc --watch"' }])))).toEqual([]);
});

test("reopen respawns a dead hunk pane", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  openReview("ws1", { allowDirty: false });
  const mb = sh(wt, "merge-base", "main", "feat");
  expect(acts(reopen(panes([SIDEBAR, { id: "%1", dead: true, start: "" }])))).toEqual([`tmux respawn-pane -k -t %1 -c ${wt} hunk diff ${mb} --watch`]);
});

test("reopen replaces a hunk pane that is gone and re-splits a missing sidebar", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  openReview("ws1", { allowDirty: false });
  const mb = sh(wt, "merge-base", "main", "feat");
  expect(acts(reopen(panes([SIDEBAR])))).toEqual([
    `tmux split-window -h -t %2 -c ${wt} -P -F #{pane_id}`,
    `tmux respawn-pane -k -t %3 -c ${wt} hunk diff ${mb} --watch`,
    "tmux resize-pane -t %2 -x 44",
  ]);
  expect(loadReview("ws1")!.hunkPaneId).toBe("%3");
  expect(acts(reopen(panes([{ id: "%5", start: '"hunk diff x --watch"' }])))).toEqual([
    `tmux split-window -h -b -l 44 -c ${wt} -t %5 workbench sidebar ws1`,
  ]);
});

test("re-pointing to another worktree snapshots notes and respawns hunk there", () => {
  const a = worktree("feat");
  const b = worktree("feat2", "feat");
  const ws = workset([{ branch: "feat", worktree: a }, { branch: "feat2", worktree: b, base: "feat" }]);
  const r = openReview("ws1", { allowDirty: false });
  const n = r.commands!.length;
  const to = ws.members.find((m) => m.branch === "feat2")!;
  expect(repoint(r, ws, to, "feat")).toBe(true);
  const saved = loadReview("ws1")!;
  expect(saved.current).toBe(to.id);
  expect(saved.hunkPaneCwd).toBe(b);
  const cmds = saved.commands!.slice(n);
  expect(cmds.some((c) => c.startsWith("hunk session reload"))).toBe(false);
  expect(cmds).toContain(`tmux respawn-pane -k -t %1 -c ${b} hunk diff ${sh(b, "merge-base", "feat", "feat2")} --watch`);
  const notes = join(tmp, "state", "reviews", "ws1", "notes", `${repo.replace(/[/#]/g, "_")}_feat.json`);
  expect(existsSync(notes)).toBe(true);
  expect(loadNotes("ws1", `${repo}#feat`)).toEqual([]);
});

test("re-pointing within the hunk worktree reloads, and falls back to a respawn when reload fails", () => {
  const a = worktree("feat");
  const ws = workset([{ branch: "feat", worktree: a }]);
  const r = openReview("ws1", { allowDirty: false });
  const m = ws.members[0];
  const mb = sh(a, "merge-base", "main", "feat");
  let n = r.commands!.length;
  expect(repoint(r, ws, m, "main")).toBe(true);
  expect(loadReview("ws1")!.commands!.slice(n)).toContain(`hunk session reload --session-path ${a} --source ${a} --json -- diff ${mb}`);
  process.env.WORKBENCH_DRY_RUN_FAIL = "hunk session reload";
  n = loadReview("ws1")!.commands!.length;
  expect(repoint(r, ws, m, "main")).toBe(true);
  const cmds = loadReview("ws1")!.commands!.slice(n);
  expect(cmds.findIndex((c) => c.startsWith("hunk session reload"))).toBeLessThan(cmds.findIndex((c) => c.startsWith("tmux respawn-pane")));
  process.env.WORKBENCH_DRY_RUN_FAIL = "hunk session reload,tmux respawn-pane";
  expect(repoint(r, ws, m, "main")).toBe(false);
});
