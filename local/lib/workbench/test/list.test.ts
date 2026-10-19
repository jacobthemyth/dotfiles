import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteSlug } from "../src/git";
import { run as worksetRun } from "../src/cmd/workset";
import { loadWorkset, saveWorkset, type Member, type Workset } from "../src/workset";

const ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [], e: string[] = [];
  const lo = console.log, le = console.error;
  console.log = (...a) => o.push(a.join(" ")); console.error = (...a) => e.push(a.join(" "));
  try { return { code: await fn(), out: o.join("\n"), err: e.join("\n") }; } finally { console.log = lo; console.error = le; }
}

let tmp: string;
const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_GH_STUB", "WORKBENCH_CLAUDE_PROJECTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-list-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_CLAUDE_PROJECTS = join(tmp, "projects");
  delete process.env.WORKBENCH_GH_STUB;
  mkdirSync(join(tmp, "repos"), { recursive: true });
  writeFileSync(join(tmp, "config.toml"), `repo_roots = ["${join(tmp, "repos", "*")}"]\ndefault_branch = "main"\n`);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function mkRepo(name: string): string {
  const dir = join(tmp, "repos", name);
  sh(tmp, "init", "-q", "-b", "main", dir);
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  const bare = join(tmp, `${name}-origin.git`);
  sh(tmp, "init", "-q", "--bare", "-b", "main", bare);
  sh(dir, "remote", "add", "origin", bare);
  sh(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}
function mkWorktree(repo: string, name: string): { path: string; tip: string } {
  const path = join(repo, ".worktrees", name);
  sh(repo, "worktree", "add", "-q", "-b", name, path, "main");
  sh(path, "commit", "-q", "--allow-empty", "-m", name);
  sh(path, "push", "-q", "-u", "origin", name);
  return { path, tip: sh(path, "rev-parse", "HEAD") };
}
const mem = (repo: string, branch: string, over: Partial<Member> = {}): Member => ({
  id: `${remoteSlug(repo) ?? repo}#${branch}`, repo, slug: remoteSlug(repo), branch, worktree: null, base: null, base_source: null,
  pr: null, order: null, role: "work", added_by: "t", added_at: "2026-01-01T00:00:00.000Z", ...over,
});
const wsOf = (name: string, members: Member[]): Workset => ({ name, created: "2026-01-01T00:00:00.000Z", members, sessions: [], ignored: [] });
const DEFAULT_NAME = "claude-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const pr = (state: string, number: number) => ({ number, url: `https://x/pull/${number}`, draft: false, state });
const stub = (map: Record<string, unknown>) => {
  const f = join(tmp, "stub.json");
  writeFileSync(f, JSON.stringify({ prsForBranches: map, myPrs: [] }));
  process.env.WORKBENCH_GH_STUB = f;
};

// "done" holds a merged PR (default-named, prune); "cinf-1" holds an open PR; "extra" is claimed by nobody.
function fixture() {
  const a = mkRepo("a");
  const merged = mkWorktree(a, "merged");
  const open = mkWorktree(a, "open");
  mkWorktree(a, "extra");
  stub({
    merged: { pr: pr("MERGED", 1), base: "main", headRefOid: merged.tip },
    open: { pr: pr("OPEN", 2), base: "main", headRefOid: open.tip },
  });
  saveWorkset(wsOf(DEFAULT_NAME, [mem(a, "merged", { worktree: merged.path })]));
  saveWorkset(wsOf("cinf-1", [mem(a, "open", { worktree: open.path })]));
  return { a };
}

test("list prints one row per workset in action order with the pr mix, and no unclaimed footer", async () => {
  fixture();
  const r = await capture(() => worksetRun(["list"]));
  expect(r.code).toBe(0);
  const lines = r.out.split("\n");
  expect(lines[0].split(/\s+/).slice(0, 8)).toEqual(["action", "name", "kind", "members", "pr", "dirty", "sessions", "last"]);
  expect(lines[1]).toMatch(/^prune\s+/);
  expect(lines[1]).toContain(DEFAULT_NAME);
  expect(lines[1]).toMatch(/\sdefault\s/);
  expect(lines[1]).toContain("1m 0c 0o 0n");
  expect(lines[1]).toContain("0 open / 0 stale / 0 closed");
  expect(lines[2]).toContain("cinf-1");
  expect(lines[2]).toMatch(/\snamed\s/);
  expect(lines[2]).toContain("0m 0c 1o 0n");
  expect(lines[2].trimEnd()).toMatch(/ -$/);
  expect(lines).toHaveLength(3);
});

test("list --unclaimed adds the unclaimed footer", async () => {
  const { a } = fixture();
  const r = await capture(() => worksetRun(["list", "--unclaimed"]));
  expect(r.code).toBe(0);
  const lines = r.out.split("\n");
  expect(lines[3]).toBe("");
  expect(lines[4]).toBe("unclaimed per repo:");
  expect(lines[5]).toBe(`${remoteSlug(a)}  1`);
  expect(lines).toHaveLength(6);
});

test("list --json shape: unclaimed only with --unclaimed", async () => {
  const { a } = fixture();
  const r = await capture(() => worksetRun(["list", "--json"]));
  const j = JSON.parse(r.out);
  expect(j.worksets[0].action).toBe("prune");
  expect(j.worksets).toHaveLength(2);
  expect("unclaimed" in j).toBe(false);
  const u = JSON.parse((await capture(() => worksetRun(["list", "--json", "--unclaimed"]))).out);
  expect(u.unclaimed).toEqual({ [remoteSlug(a)!]: 1 });
});

test("list counts dirty worktrees, not files", async () => {
  const a = mkRepo("a");
  const w = mkWorktree(a, "open");
  writeFileSync(join(w.path, "one.txt"), "1");
  writeFileSync(join(w.path, "two.txt"), "2");
  stub({ open: { pr: pr("OPEN", 2), base: "main", headRefOid: w.tip } });
  saveWorkset(wsOf("cinf-1", [mem(a, "open", { worktree: w.path })]));
  const j = JSON.parse((await capture(() => worksetRun(["list", "--json"]))).out);
  expect(j.worksets[0].dirty).toBe(1);
  expect(j.worksets[0].members[0].dirty).toBe(2);
});

test("list refreshes the stored pr", async () => {
  fixture();
  expect(loadWorkset("cinf-1")!.members[0].pr).toBeNull();
  await capture(() => worksetRun(["list"]));
  expect(loadWorkset("cinf-1")!.members[0].pr?.state).toBe("OPEN");
});

test("list says so on stderr when gh is down and keeps the stored pr", async () => {
  const a = mkRepo("a");
  const w = mkWorktree(a, "open");
  const stored = { number: 5, url: "u", draft: false, state: "MERGED" };
  saveWorkset(wsOf("cinf-1", [mem(a, "open", { worktree: w.path, pr: stored })]));
  const oldPath = process.env.PATH;
  process.env.PATH = join(tmp, "nobin"); // gh cannot run
  try {
    const r = await capture(() => worksetRun(["list"]));
    expect(r.err).toContain("gh not available: PR state from stored members");
  } finally { process.env.PATH = oldPath; }
  expect(loadWorkset("cinf-1")!.members[0].pr).toEqual(stored);
});
