import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { remoteSlug } from "../src/git";
import * as gh from "../src/gh";
import { sub } from "../src/paths";
import { writeJson } from "../src/store";
import { savePointer, type Pointer } from "../src/session";
import { transcriptPath } from "../src/harness/claude";
import { inboxFile } from "../src/submit";
import { saveWorkset, type Member, type Workset } from "../src/workset";
import { isNamed, memberStatuses, refreshStoredPr, summarize, summarizeAll } from "../src/triage";

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
const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_GH_STUB", "WORKBENCH_CLAUDE_PROJECTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-triage-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_CLAUDE_PROJECTS = join(tmp, "projects");
  delete process.env.WORKBENCH_GH_STUB;
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
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
// A branch with one commit beyond main, optionally pushed with upstream; main stays checked out.
function mkBranch(repo: string, name: string, push: boolean): string {
  sh(repo, "checkout", "-q", "-b", name);
  sh(repo, "commit", "-q", "--allow-empty", "-m", name);
  if (push) sh(repo, "push", "-q", "-u", "origin", name);
  const tip = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "main");
  return tip;
}
function mkWorktree(repo: string, name: string, push: boolean): { path: string; tip: string } {
  const path = join(repo, ".worktrees", name);
  sh(repo, "worktree", "add", "-q", "-b", name, path, "main");
  sh(path, "commit", "-q", "--allow-empty", "-m", name);
  if (push) sh(path, "push", "-q", "-u", "origin", name);
  return { path, tip: sh(path, "rev-parse", "HEAD") };
}
const mem = (repo: string, branch: string, over: Partial<Member> = {}): Member => ({
  id: `${remoteSlug(repo) ?? repo}#${branch}`, repo, slug: remoteSlug(repo), branch, worktree: null, base: null, base_source: null,
  pr: null, order: null, role: "work", added_by: "t", added_at: "2026-01-01T00:00:00.000Z", ...over,
});
const wsOf = (name: string, members: Member[], sessions: string[] = []): Workset => ({ name, created: "2026-01-01T00:00:00.000Z", members, sessions, ignored: [] });
const DEFAULT_NAME = "claude-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const pr = (state: string, number = 1) => ({ number, url: `https://x/pull/${number}`, draft: false, state });
const stub = (map: Record<string, { pr: ReturnType<typeof pr>; base: string; headRefOid: string }>) => {
  const f = join(tmp, "stub.json");
  writeFileSync(f, JSON.stringify({ prsForBranches: map }));
  process.env.WORKBENCH_GH_STUB = f;
};

function pointer(session: string, cwd: string, over: Partial<Pointer> = {}): Pointer {
  const p: Pointer = { key: `claude-${session}`, harness: "claude", session, workset: `claude-${session}`, cwd, opened: "2026-01-01T00:00:00.000Z", closed: null, ...over };
  savePointer(p);
  return p;
}
function transcript(cwd: string, session: string, mtimeMs: number) {
  const f = transcriptPath(cwd, session);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, "{}\n");
  utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
}

type Fix = { alpha: string; beta: string; members: Member[]; mergedWt: string; dirtyWt: string };
function fixture(): Fix {
  const alpha = mkRepo("alpha"), beta = mkRepo("beta");
  const merged = mkWorktree(alpha, "merged", true);
  const closedTip = mkBranch(alpha, "closed", true);
  const openTip = mkBranch(alpha, "open", true);
  mkBranch(alpha, "gone-up", true);
  sh(alpha, "merge", "-q", "--no-ff", "-m", "merge gone-up", "gone-up");
  sh(alpha, "push", "-q", "origin", ":gone-up");
  sh(alpha, "fetch", "-q", "-p");
  mkBranch(alpha, "local-only", false);
  const dirty = mkWorktree(beta, "dirty", true);
  writeFileSync(join(dirty.path, "scratch.txt"), "x");
  stub({
    merged: { pr: pr("MERGED", 1), base: "main", headRefOid: merged.tip },
    closed: { pr: pr("CLOSED", 2), base: "main", headRefOid: closedTip },
    open: { pr: pr("OPEN", 3), base: "main", headRefOid: openTip },
    dirty: { pr: pr("MERGED", 4), base: "main", headRefOid: dirty.tip },
  });
  const members = [
    mem(alpha, "merged", { worktree: merged.path }), mem(alpha, "closed"), mem(alpha, "open"), mem(alpha, "gone-up"),
    mem(alpha, "local-only"), mem(beta, "dirty", { worktree: dirty.path }),
  ];
  return { alpha, beta, members, mergedWt: merged.path, dirtyWt: dirty.path };
}
const byBranch = (s: ReturnType<typeof memberStatuses>) => Object.fromEntries(s.map((x) => [x.member.branch, x]));

test("isNamed rejects only the default agent-session name", () => {
  expect(isNamed(DEFAULT_NAME)).toBe(false);
  expect(isNamed("cinf-1")).toBe(true);
  expect(isNamed("claude-s1")).toBe(true);
});

test("memberStatuses classifies each member", () => {
  const f = fixture();
  const ghost = mem(f.alpha, "ghost");
  const s = byBranch(memberStatuses(wsOf("w", [...f.members, ghost])));
  expect(s.merged).toMatchObject({ pr: "merged", prNumber: 1, prBase: "main", prunable: true, reason: "merged", branchExists: true, worktreeExists: true, repoExists: true });
  expect(s.closed).toMatchObject({ pr: "closed", prunable: false, reason: "closed PR" });
  expect(s.open).toMatchObject({ pr: "open", prunable: false, reason: "open PR" });
  expect(s["gone-up"]).toMatchObject({ pr: "nopr", prunable: true, reason: "remote-gone" });
  expect(s["local-only"]).toMatchObject({ prunable: false, reason: "unmerged work", unpushed: true });
  expect(s.dirty).toMatchObject({ prunable: false, reason: "dirty, 1 file", dirty: 1 });
  expect(s.ghost).toMatchObject({ prunable: true, reason: "branch gone", branchExists: false });
  expect(s.merged.unpushed).toBe(false);
});

test("dirty reason pluralises", () => {
  const f = fixture();
  writeFileSync(join(f.dirtyWt, "two.txt"), "y");
  const s = byBranch(memberStatuses(wsOf("w", f.members)));
  expect(s.dirty).toMatchObject({ dirty: 2, reason: "dirty, 2 files" });
});

test("a missing repo is prunable and runs no git", () => {
  const f = fixture();
  const gone = mem(join(tmp, "nope"), "x", { slug: null, worktree: join(tmp, "nope", ".worktrees", "x") });
  const [s] = memberStatuses(wsOf("w", [gone]));
  expect(s).toMatchObject({ repoExists: false, branchExists: false, worktreeExists: false, dirty: 0, prunable: true, reason: "repo gone" });
  void f;
});

test("a null slug skips the PR lookup and classifies by git only", () => {
  const repo = mkRepo("plain", false);
  mkBranch(repo, "work", false);
  const calls: string[] = [];
  const prs = ((slug: string, b: string[]) => { calls.push(slug); return new Map(); }) as typeof gh.prsForBranches;
  const [s] = memberStatuses(wsOf("w", [mem(repo, "work")]), { prs });
  expect(calls).toEqual([]);
  expect(s).toMatchObject({ pr: "nopr", prunable: false, reason: "unmerged work", unpushed: true });
});

test("one prsForBranches call per distinct slug", () => {
  const f = fixture();
  const calls: { slug: string; branches: string[] }[] = [];
  const prs = ((slug: string, branches: string[]) => { calls.push({ slug, branches }); return gh.prsForBranches(slug, branches); }) as typeof gh.prsForBranches;
  memberStatuses(wsOf("w", f.members), { prs });
  expect(calls.length).toBe(2);
  expect(calls.map((c) => c.slug).sort()).toEqual([remoteSlug(f.alpha)!, remoteSlug(f.beta)!].sort());
  expect(calls.find((c) => c.slug === remoteSlug(f.alpha))!.branches.sort()).toEqual(["closed", "gone-up", "local-only", "merged", "open"]);
});

test("an open session in the worktree blocks pruning", () => {
  const f = fixture();
  pointer("s1", f.mergedWt);
  transcript(f.mergedWt, "s1", Date.now());
  const s = byBranch(memberStatuses(wsOf("w", f.members)));
  expect(s.merged).toMatchObject({ cwdOf: "claude-s1", prunable: false, reason: "cwd of open session claude-s1" });
  expect(s.dirty.cwdOf).toBeNull();
});

test("a stale or closed session does not claim the worktree", () => {
  const f = fixture();
  pointer("s1", f.mergedWt);
  transcript(f.mergedWt, "s1", Date.now() - 3 * 86400_000);
  expect(byBranch(memberStatuses(wsOf("w", f.members))).merged).toMatchObject({ cwdOf: null, prunable: true });
});

test("merged PR is prunable only when the local tip is covered by the PR head", () => {
  const repo = mkRepo("guard");
  const first = mkBranch(repo, "two", true);
  sh(repo, "checkout", "-q", "two");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "second");
  sh(repo, "checkout", "-q", "main");
  const tip = sh(repo, "rev-parse", "two");
  expect(tip).not.toBe(first);
  const m = mem(repo, "two");
  stub({ two: { pr: pr("MERGED"), base: "main", headRefOid: first } });
  const [beyond] = memberStatuses(wsOf("w", [m]));
  expect(beyond).toMatchObject({ pr: "merged", headRefOid: first, prunable: false, reason: "merged PR but local commits beyond its head" });
  stub({ two: { pr: pr("MERGED"), base: "main", headRefOid: tip } });
  expect(memberStatuses(wsOf("w", [m]))[0]).toMatchObject({ prunable: true, reason: "merged" });
  // PR head ahead of the local tip (known locally): local tip is an ancestor, still covered.
  sh(repo, "branch", "-f", "two", first);
  expect(memberStatuses(wsOf("w", [m]))[0]).toMatchObject({ prunable: true, reason: "merged" });
});

test("a gh failure falls back to the stored PR state and never prunes on it", () => {
  const f = fixture();
  delete process.env.WORKBENCH_GH_STUB;
  const stored = [
    mem(f.alpha, "merged", { worktree: f.mergedWt, pr: pr("MERGED", 1) }),
    mem(f.alpha, "closed", { pr: pr("CLOSED", 2) }),
    mem(f.alpha, "open", { pr: pr("OPEN", 3), base: "feature-below", base_source: "declared" }),
    mem(f.alpha, "local-only"),
  ];
  const ws = wsOf("w", stored);
  const prs = ((slug: string, b: string[]) => gh.prsForBranches(slug, b, { run: () => null })) as typeof gh.prsForBranches;
  const s = memberStatuses(ws, { prs });
  expect(gh.lastGhError).not.toBeNull();
  expect(byBranch(s).merged).toMatchObject({ pr: "merged", prNumber: 1, headRefOid: null, prunable: false });
  expect(byBranch(s).closed).toMatchObject({ pr: "closed", prunable: false, reason: "closed PR" });
  expect(byBranch(s).open).toMatchObject({ pr: "open", reason: "open PR" });
  expect(byBranch(s)["local-only"].pr).toBe("nopr");
  const before = JSON.stringify(ws);
  expect(refreshStoredPr(ws, s)).toBe(false);
  expect(JSON.stringify(ws)).toBe(before);
});

test("summarize: all-prunable default workset prunes, an open PR asks for a name, a name settles it", () => {
  const f = fixture();
  const [merged, , open, goneUp] = f.members;
  expect(summarize(wsOf(DEFAULT_NAME, [merged, goneUp])).action).toBe("prune");
  expect(summarize(wsOf(DEFAULT_NAME, [merged, goneUp, open])).action).toBe("name");
  expect(summarize(wsOf("cinf-1", [merged, goneUp, open])).action).toBe("-");
  const s = summarize(wsOf(DEFAULT_NAME, [merged, open, f.members[4], f.members[5]]));
  expect(s.prMix).toEqual({ merged: 2, closed: 0, open: 1, nopr: 1 });
  expect(s.dirty).toBe(1);
  expect(s.named).toBe(false);
});

test("summarize: a review lock or an unread review wins over everything", () => {
  const f = fixture();
  const [merged, , , goneUp] = f.members;
  writeJson(join(sub("locks"), "cinf-1.json"), { workset: "cinf-1", review: "r1", paths: [], opened: "2026-01-01T00:00:00.000Z", holder: "t" });
  expect(summarize(wsOf("cinf-1", [merged, goneUp])).action).toBe("review");
  expect(summarize(wsOf("cinf-2", [merged, goneUp], ["claude-s1"])).action).toBe("prune");
  writeJson(inboxFile("claude-s1", "r1"), { id: "r1", read: false });
  expect(summarize(wsOf("cinf-2", [merged, goneUp], ["claude-s1"])).action).toBe("review");
});

test("summarize: empty default workset prunes unless a session is open on it", () => {
  const empty = wsOf(DEFAULT_NAME, []);
  expect(summarize(empty).action).toBe("prune");
  pointer("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", tmp);
  transcript(tmp, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", Date.now());
  expect(summarize(empty).action).toBe("-");
});

test("summarize.sessions counts pointer states and reports the latest activity", () => {
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const live = nowMs - 3600_000;
  pointer("s1", "/w/one", { workset: "w1" });
  transcript("/w/one", "s1", live);
  pointer("s2", "/w/two", { workset: "w1" });
  transcript("/w/two", "s2", nowMs - 3 * 86400_000);
  pointer("s3", "/w/three", { workset: "w1", closed: "2026-01-02T00:00:00.000Z" });
  pointer("s4", "/w/four", { workset: "other" });
  const s = summarize(wsOf("w1", []), { nowMs });
  expect(s.sessions).toEqual({ open: 1, stale: 1, closed: 1, last: new Date(live).toISOString() });
  expect(summarize(wsOf("nobody", []), { nowMs }).sessions.last).toBeNull();
});

test("summarizeAll orders review, prune, name, then dash", () => {
  const f = fixture();
  const [merged, , open, goneUp] = f.members;
  saveWorkset(wsOf("cinf-quiet", [open]));
  saveWorkset(wsOf(DEFAULT_NAME, [merged, goneUp]));
  saveWorkset(wsOf("cinf-locked", [open]));
  writeJson(join(sub("locks"), "cinf-locked.json"), { workset: "cinf-locked", review: "r1", paths: [], opened: "2026-01-01T00:00:00.000Z", holder: "t" });
  expect(summarizeAll().map((s) => [s.name, s.action])).toEqual([["cinf-locked", "review"], [DEFAULT_NAME, "prune"], ["cinf-quiet", "-"]]);
});

test("refreshStoredPr adopts the PR and its base, and is a no-op the second time", () => {
  const f = fixture();
  const m = mem(f.alpha, "open", { base: "feature-below", base_source: "declared" });
  const ws = wsOf("w", [m]);
  const s = memberStatuses(ws);
  expect(refreshStoredPr(ws, s)).toBe(true);
  expect(m.pr).toMatchObject({ number: 3, state: "OPEN" });
  expect(m.base).toBe("main");
  expect(m.base_source).toBe("pr");
  expect(refreshStoredPr(ws, memberStatuses(ws))).toBe(false);
});

test("a gone upstream prunes only work that reached the default branch", () => {
  const repo = mkRepo("gone");
  mkBranch(repo, "ahead", true);
  sh(repo, "push", "-q", "origin", ":ahead");
  sh(repo, "fetch", "-q", "-p");
  const [s] = memberStatuses(wsOf("w", [mem(repo, "ahead")]));
  expect(s).toMatchObject({ prunable: false, reason: "remote gone but local commits not in main" });
});

test("a gone branch does not hide uncommitted files or an open session in its worktree", () => {
  const repo = mkRepo("orphan");
  const a = mkWorktree(repo, "a", true), b = mkWorktree(repo, "b", true);
  for (const x of [a, b]) { sh(x.path, "checkout", "-q", "--detach"); sh(repo, "branch", "-D", x.path.endsWith("/a") ? "a" : "b"); }
  writeFileSync(join(a.path, "scratch.txt"), "x");
  pointer("s9", b.path);
  transcript(b.path, "s9", Date.now());
  const s = byBranch(memberStatuses(wsOf("w", [mem(repo, "a", { worktree: a.path }), mem(repo, "b", { worktree: b.path })])));
  expect(s.a).toMatchObject({ branchExists: false, prunable: false, reason: "dirty, 1 file" });
  expect(s.b).toMatchObject({ branchExists: false, prunable: false, reason: "cwd of open session claude-s9" });
  const clean = memberStatuses(wsOf("w", [mem(repo, "a", { worktree: null })]))[0];
  expect(clean).toMatchObject({ prunable: true, reason: "branch gone" });
});

test("the guard fetches the PR head from origin when it is not a local object", () => {
  const repo = mkRepo("fetch");
  const a = mkBranch(repo, "pf", true);
  sh(repo, "checkout", "-q", "-b", "tmp", "pf");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "B");
  const b = sh(repo, "rev-parse", "HEAD");
  sh(repo, "push", "-q", "origin", "tmp:refs/pull/9/head");
  sh(repo, "checkout", "-q", "main");
  sh(repo, "branch", "-D", "tmp");
  sh(repo, "reflog", "expire", "--expire=now", "--all");
  sh(repo, "prune", "--expire=now");
  expect(Bun.spawnSync(["git", "cat-file", "-e", b], { cwd: repo, env: ENV }).exitCode).not.toBe(0);
  stub({ pf: { pr: pr("MERGED", 9), base: "main", headRefOid: b } });
  expect(sh(repo, "rev-parse", "pf")).toBe(a);
  expect(memberStatuses(wsOf("w", [mem(repo, "pf")]))[0]).toMatchObject({ prunable: true, reason: "merged" });
  expect(sh(repo, "for-each-ref", "refs/pull")).toBe("");
});

test("an unknown PR head that cannot be fetched blocks pruning", () => {
  const repo = mkRepo("nofetch");
  mkBranch(repo, "pf", true);
  stub({ pf: { pr: pr("MERGED", 9), base: "main", headRefOid: "deadbeef".repeat(5) } });
  expect(memberStatuses(wsOf("w", [mem(repo, "pf")]))[0]).toMatchObject({ prunable: false, reason: "merged PR but local commits beyond its head" });
});
