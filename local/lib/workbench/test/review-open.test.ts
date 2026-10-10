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
const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN"] as const;
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

test("dry run records new-session, hunk diff and split-window in order", () => {
  const wt = worktree("feat");
  workset([{ branch: "feat", worktree: wt }]);
  const cmds = openReview("ws1", { allowDirty: false }).commands!;
  const at = (s: string) => cmds.findIndex((c) => c.startsWith(s));
  const ns = at("tmux new-session"), hd = cmds.findIndex((c) => c.includes("hunk diff main...feat --watch")), sw = at("tmux split-window");
  expect(cmds[ns]).toContain(`-d -s wb-ws1 -c ${wt} -x 220 -y 60`);
  expect(cmds[sw]).toContain(`-h -b -l 44 -c ${wt}`);
  expect(cmds[sw]).toEndWith("workbench sidebar ws1");
  expect(ns).toBeGreaterThanOrEqual(0);
  expect(hd).toBeGreaterThan(ns);
  expect(sw).toBeGreaterThan(hd);
});

test("re-pointing snapshots the live member's notes, reloads hunk on the other worktree and moves current", () => {
  const a = worktree("feat");
  const b = worktree("feat2", "feat");
  const ws = workset([{ branch: "feat", worktree: a }, { branch: "feat2", worktree: b, base: "feat" }]);
  const r = openReview("ws1", { allowDirty: false });
  const to = ws.members.find((m) => m.branch === "feat2")!;
  expect(repoint(r, ws, to, "feat")).toBe(true);
  const saved = loadReview("ws1")!;
  expect(saved.current).toBe(to.id);
  expect(saved.commands!.at(-1)).toBe(`hunk session reload --session-path ${a} --source ${b} --json -- diff feat...feat2`);
  const notes = join(tmp, "state", "reviews", "ws1", "notes", `${repo.replace(/[/#]/g, "_")}_feat.json`);
  expect(existsSync(notes)).toBe(true);
  expect(loadNotes("ws1", `${repo}#feat`)).toEqual([]);
});
