import { test, expect, beforeEach, afterEach } from "bun:test";
import { symlinkSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteSlug } from "../src/git";
import { derive, prunable, unclaimed, type Found } from "../src/derive";
import type { Config } from "../src/config";
import type { Workset } from "../src/workset";
import { run as worksetRun } from "../src/cmd/workset";
import { run as scanRun } from "../src/cmd/scan";
import { loadWorkset, createWorkset, saveWorkset } from "../src/workset";

const ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

let tmp: string;
const saved = { cfg: process.env.WORKBENCH_CONFIG, st: process.env.WORKBENCH_STATE_DIR, gh: process.env.WORKBENCH_GH_STUB };
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-derive-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  delete process.env.WORKBENCH_GH_STUB;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["WORKBENCH_CONFIG", saved.cfg], ["WORKBENCH_STATE_DIR", saved.st], ["WORKBENCH_GH_STUB", saved.gh]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function mkRepo(name: string, origin = true): string {
  const root = join(tmp, "repos");
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  sh(root, "init", "-q", "-b", "main", dir);
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  if (origin) {
    const bare = join(tmp, `${name}-origin.git`);
    sh(tmp, "init", "-q", "--bare", "-b", "main", bare);
    sh(dir, "remote", "add", "origin", bare);
    sh(dir, "push", "-q", "-u", "origin", "main");
  }
  return dir;
}
const cfg = (over: Partial<Config> = {}): Config => ({
  repo_roots: [join(tmp, "repos", "*")], worktree_dirs: [".worktrees"], exclude_repos: [], github_user: "@me",
  harnesses: ["claude"], default_branch: "main", ...over,
});
const idOf = (repo: string, branch: string) => `${remoteSlug(repo) ?? repo}#${branch}`;
const none = { myPrs: () => [] };

test("derive lists worktree branches in configured roots and skips excluded repos", () => {
  const a = mkRepo("a", false), b = mkRepo("b", false);
  sh(a, "worktree", "add", "-q", "-b", "feat/a", join(a, ".worktrees", "feat-a"));
  sh(b, "worktree", "add", "-q", "-b", "feat/b", join(b, ".worktrees", "feat-b"));
  const all = derive(cfg(), none);
  expect(all.map((f) => `${f.repo}#${f.branch}`).sort()).toEqual([`${a}#feat/a`, `${b}#feat/b`]);
  expect(all.find((f) => f.branch === "feat/a")).toMatchObject({ worktree: join(a, ".worktrees", "feat-a"), main: false, pr: null });
  const some = derive(cfg({ exclude_repos: [b] }), none);
  expect(some.map((f) => f.branch)).toEqual(["feat/a"]);
});

test("derive finds worktrees of the repo in an absolute worktree dir and keeps a main worktree off the default branch", () => {
  const a = mkRepo("a", false);
  const wd = join(tmp, "wt");
  sh(a, "worktree", "add", "-q", "-b", "feat/x", join(wd, "x"));
  mkdirSync(join(wd, "plain")); // not a worktree
  sh(a, "checkout", "-q", "-b", "side");
  const all = derive(cfg({ worktree_dirs: [wd] }), none);
  expect(all.map((f) => [f.branch, f.main]).sort()).toEqual([["feat/x", false], ["side", true]]);
});

test("derive attaches PRs by head branch, one lookup per repo", () => {
  const a = mkRepo("a");
  sh(a, "worktree", "add", "-q", "-b", "feat/a", join(a, ".worktrees", "feat-a"));
  sh(a, "worktree", "add", "-q", "-b", "feat/b", join(a, ".worktrees", "feat-b"));
  sh(a, "remote", "set-url", "origin", "git@github.com:o/a.git");
  let calls = 0;
  const pr = { number: 7, url: "u", draft: false, state: "OPEN" };
  const found = derive(cfg(), { myPrs: (slug) => { calls++; expect(slug).toBe("o/a"); return [{ pr, branch: "feat/a", base: "feat/b" }]; } });
  expect(calls).toBe(1);
  expect(found.find((f) => f.branch === "feat/a")).toMatchObject({ slug: "o/a", pr, base: "feat/b" });
  expect(found.find((f) => f.branch === "feat/b")?.pr).toBeNull();
});

test("derive prefers an open PR over a merged one on the same branch, and caches per slug across clones", () => {
  const a = mkRepo("a"), b = mkRepo("b");
  sh(a, "worktree", "add", "-q", "-b", "feat/a", join(a, ".worktrees", "feat-a"));
  sh(a, "remote", "set-url", "origin", "git@github.com:o/same.git");
  sh(b, "remote", "set-url", "origin", "git@github.com:o/same.git");
  let calls = 0;
  const mk = (number: number, state: string) => ({ pr: { number, url: "", draft: false, state }, branch: "feat/a", base: "main" });
  const found = derive(cfg(), { myPrs: () => { calls++; return [mk(1, "MERGED"), mk(2, "OPEN"), mk(3, "CLOSED")]; } });
  expect(calls).toBe(1);
  expect(found.find((x) => x.branch === "feat/a")?.pr?.number).toBe(2);
  const only = derive(cfg(), { myPrs: () => [mk(1, "CLOSED"), mk(4, "MERGED")] });
  expect(prunable(only).map((x) => [x.found.branch, x.reason])).toEqual([["feat/a", "merged"]]);
});

test("derive collapses symlinked paths: each worktree once, main flagged", () => {
  const a = mkRepo("a");
  const link = join(tmp, "link");
  symlinkSync(a, link);
  sh(link, "worktree", "add", "-q", "-b", "feat/a", join(link, ".worktrees", "feat-a"));
  sh(link, "checkout", "-q", "-b", "side");
  const found = derive(cfg({ repo_roots: [link] }), none);
  expect(found.map((x) => [x.branch, x.main]).sort()).toEqual([["feat/a", false], ["side", true]]);
});

test("derive only takes worktrees of the same repo from a shared absolute worktree dir", () => {
  const a = mkRepo("a", false), b = mkRepo("b", false);
  const wd = join(tmp, "shared");
  sh(a, "worktree", "add", "-q", "-b", "feat/a", join(wd, "wa"));
  sh(b, "worktree", "add", "-q", "-b", "feat/b", join(wd, "wb"));
  const found = derive(cfg({ worktree_dirs: [wd] }), none);
  expect(found.filter((x) => x.repo === a).map((x) => x.branch)).toEqual(["feat/a"]);
  expect(found.filter((x) => x.repo === b).map((x) => x.branch)).toEqual(["feat/b"]);
});

const f = (branch: string): Found => ({ repo: "/r", slug: "o/r", branch, worktree: null, pr: null, base: null, main: false });
const ws = (members: string[], ignored: string[]): Workset => ({
  name: "w", created: "", sessions: [], ignored,
  members: members.map((id) => ({ id } as Workset["members"][number])),
});

test("unclaimed excludes members of any workset and ignored ids", () => {
  const out = unclaimed([f("a"), f("b"), f("c"), f("d")], [ws(["o/r#a"], []), ws([], ["o/r#b"])]);
  expect(out.map((x) => x.branch)).toEqual(["c", "d"]);
});

test("prunable flags a worktree whose branch's upstream is gone", () => {
  const a = mkRepo("a");
  const wt = join(a, ".worktrees", "gone");
  sh(a, "worktree", "add", "-q", "-b", "gone", wt);
  sh(wt, "push", "-q", "-u", "origin", "gone");
  sh(wt, "worktree", "add", "-q", "-b", "kept", join(a, ".worktrees", "kept"), "main");
  sh(a, "push", "-q", "origin", "--delete", "gone");
  sh(a, "fetch", "-q", "--prune");
  const found = derive(cfg(), none);
  const p = prunable(found);
  expect(p.map((x) => [x.found.branch, x.reason])).toEqual([["gone", "remote-gone"]]);
});

test("prunable flags merged PRs but never a main worktree", () => {
  const merged = { ...f("m"), pr: { number: 1, url: "", draft: false, state: "MERGED" } };
  const main = { ...merged, branch: "mm", main: true };
  expect(prunable([merged, main]).map((x) => [x.found.branch, x.reason])).toEqual([["m", "merged"]]);
});

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [], e: string[] = [];
  const lo = console.log, le = console.error;
  console.log = (...a) => o.push(a.join(" ")); console.error = (...a) => e.push(a.join(" "));
  try { return { code: await fn(), out: o.join("\n"), err: e.join("\n") }; } finally { console.log = lo; console.error = le; }
}

function setup() {
  const a = mkRepo("a");
  const wt = join(a, ".worktrees", "gone");
  sh(a, "worktree", "add", "-q", "-b", "gone", wt);
  sh(wt, "push", "-q", "-u", "origin", "gone");
  sh(a, "push", "-q", "origin", "--delete", "gone");
  sh(a, "fetch", "-q", "--prune");
  sh(a, "worktree", "add", "-q", "-b", "live", join(a, ".worktrees", "live"));
  writeFileSync(join(tmp, "gh.json"), JSON.stringify({ myPrs: [] }));
  process.env.WORKBENCH_GH_STUB = join(tmp, "gh.json");
  writeFileSync(process.env.WORKBENCH_CONFIG!, `repo_roots = ["${join(tmp, "repos", "*")}"]\nworktree_dirs = [".worktrees"]\n`);
  return { a, wt, id: idOf(a, "gone") };
}

test("workset prune prints commands without --yes, and removes with --yes", async () => {
  const { a, wt, id } = setup();
  const dry = await capture(() => worksetRun(["prune", id]));
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`git worktree remove ${wt}`);
  expect(dry.out).toContain("git branch -D gone");
  expect(sh(a, "branch", "--list", "gone")).not.toBe("");
  const live = await capture(() => worksetRun(["prune", idOf(a, "live"), "--yes"]));
  expect(live.code).toBe(1);
  expect(sh(a, "branch", "--list", "live")).not.toBe("");
  const yes = await capture(() => worksetRun(["prune", id, "--yes"]));
  expect(yes.code).toBe(0);
  expect(sh(a, "branch", "--list", "gone")).toBe("");
  expect(Bun.spawnSync(["test", "-d", wt]).exitCode).not.toBe(0);
});

test("workset prune refuses an item a workset claims", async () => {
  const { a, id } = setup();
  const w = createWorkset("w", "hand"); w.members.push({ id } as never); saveWorkset(w);
  const r = await capture(() => worksetRun(["prune", id, "--yes"]));
  expect(r.code).toBe(1);
  expect(sh(a, "branch", "--list", "gone")).not.toBe("");
});

test("workset adopt creates the workset and adds the item; ignore appends once", async () => {
  const { a, wt, id } = setup();
  expect((await capture(() => worksetRun(["adopt", "w", id, "--role", "throwaway"]))).code).toBe(0);
  const w = loadWorkset("w")!;
  expect(w.members[0]).toMatchObject({ id, repo: a, branch: "gone", worktree: wt, role: "throwaway", added_by: "hand" });
  expect((await capture(() => worksetRun(["adopt", "w", "nope#x"]))).code).toBe(1);
  await worksetRun(["ignore", "w", idOf(a, "live")]);
  await worksetRun(["ignore", "w", idOf(a, "live")]);
  expect(loadWorkset("w")!.ignored).toEqual([idOf(a, "live")]);
});

test("scan groups claimed, unclaimed and prunable; --json is structured", async () => {
  const { a, id } = setup();
  const w = createWorkset("w", "hand"); w.members.push({ id: idOf(a, "live") } as never); saveWorkset(w);
  const j = JSON.parse((await capture(() => scanRun(["--json"]))).out);
  expect(j.claimed.map((c: { workset: string }) => c.workset)).toEqual(["w"]);
  expect(j.unclaimed.map((x: Found) => x.branch)).toEqual(["gone"]);
  expect(j.prunable.map((x: { reason: string }) => x.reason)).toEqual(["remote-gone"]);
  const human = (await capture(() => scanRun([]))).out;
  expect(human).toContain("claimed (w)");
  expect(human).toContain("unclaimed");
  expect(human).toContain("prunable");
  expect(human).toContain(id);
});
