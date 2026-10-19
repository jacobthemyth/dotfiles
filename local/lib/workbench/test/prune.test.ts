import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { remoteSlug } from "../src/git";
import { sub } from "../src/paths";
import { removeFile, writeJson } from "../src/store";
import { removeInbox, removePidFile } from "../src/inbox";
import { loadPointer, savePointer, type Pointer } from "../src/session";
import { transcriptPath } from "../src/harness/claude";
import { archiveFile } from "../src/review";
import { loadWorkset, saveWorkset, type Member, type Workset } from "../src/workset";
import { summarize } from "../src/triage";
import { planPrune, executePrune, sweepable, renderPlan } from "../src/prune";
import { run as worksetRun } from "../src/cmd/workset";

const ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
const hasBranch = (repo: string, b: string) => sh(repo, "branch", "--list", b) !== "";

let tmp: string;
const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_GH_STUB", "WORKBENCH_CLAUDE_PROJECTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-prune-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_CLAUDE_PROJECTS = join(tmp, "projects");
  delete process.env.WORKBENCH_GH_STUB;
  stubbed = {};
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function mkRepo(name: string): string {
  const root = join(tmp, "repos");
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  sh(root, "init", "-q", "-b", "main", dir);
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  const bare = join(tmp, `${name}-origin.git`);
  sh(tmp, "init", "-q", "--bare", "-b", "main", bare);
  sh(dir, "remote", "add", "origin", bare);
  sh(dir, "push", "-q", "-u", "origin", "main");
  return dir;
}
function mkBranch(repo: string, name: string, push: boolean): string {
  sh(repo, "checkout", "-q", "-b", name);
  sh(repo, "commit", "-q", "--allow-empty", "-m", name);
  if (push) sh(repo, "push", "-q", "-u", "origin", name);
  const tip = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "main");
  return tip;
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
const wsOf = (name: string, members: Member[], sessions: string[] = []): Workset => ({ name, created: "2026-01-01T00:00:00.000Z", members, sessions, ignored: [] });
const DEFAULT_NAME = "claude-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DEFAULT_NAME2 = "claude-aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const OPEN_NAME = "claude-aaaaaaaa-bbbb-cccc-dddd-000000000003";
const UNREAD_NAME = "claude-aaaaaaaa-bbbb-cccc-dddd-000000000004";
const pr = (state: string, number = 1) => ({ number, url: `https://x/pull/${number}`, draft: false, state });
let stubbed: Record<string, unknown> = {};
const stub = (map: Record<string, { pr: ReturnType<typeof pr>; base: string; headRefOid: string }>, replace = false) => {
  const f = join(tmp, "stub.json");
  stubbed = replace ? { ...map } : { ...stubbed, ...map };
  writeFileSync(f, JSON.stringify({ prsForBranches: stubbed }));
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
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [], e: string[] = [];
  const lo = console.log, le = console.error;
  console.log = (...a) => o.push(a.join(" ")); console.error = (...a) => e.push(a.join(" "));
  try { return { code: await fn(), out: o.join("\n"), err: e.join("\n") }; } finally { console.log = lo; console.error = le; }
}

// s1 merged (with worktree), s2 stacked on s1 with an open PR, s3 stacked on s2 with unmerged work.
function stacked(name = "stack") {
  const repo = mkRepo("stk");
  const s1 = mkWorktree(repo, "s1");
  const s2tip = mkBranch(repo, "s2", true);
  mkBranch(repo, "s3", false);
  stub({
    s1: { pr: pr("MERGED", 1), base: "main", headRefOid: s1.tip },
    s2: { pr: pr("OPEN", 2), base: "main", headRefOid: s2tip },
  });
  const m1 = mem(repo, "s1", { worktree: s1.path, base: "main", base_source: "declared" });
  const m2 = mem(repo, "s2", { base: "s1", base_source: "inferred" });
  const m3 = mem(repo, "s3", { base: "s2", base_source: "inferred" });
  saveWorkset(wsOf(name, [m1, m2, m3]));
  return { repo, s1, m1, m2, m3, name };
}
// Two dead members (a flat stub map is keyed by branch alone, so concurrent fixtures need distinct branch names): one merged with a worktree, one whose branch is gone.
function dead(name: string, branch = "done") {
  const repo = mkRepo(`dead-${name.slice(-4)}`);
  const w = mkWorktree(repo, branch);
  stub({ [branch]: { pr: pr("MERGED", 9), base: "main", headRefOid: w.tip } });
  const members = [mem(repo, branch, { worktree: w.path }), mem(repo, "ghost")];
  saveWorkset(wsOf(name, members));
  return { repo, w, members };
}

test("planPrune on a mixed workset", () => {
  const f = stacked();
  const plan = planPrune(loadWorkset(f.name)!);
  expect(plan.refused).toBeNull();
  expect(plan.members.map((m) => m.status.member.branch)).toEqual(["s1"]);
  expect(plan.members[0].cmds).toEqual([`git worktree remove ${f.s1.path}`, `git update-ref -d refs/heads/s1 ${f.s1.tip}`]);
  expect(plan.kept.map((k) => [k.member.branch, k.reason])).toEqual([["s2", "open PR"], ["s3", "unmerged work"]]);
  expect(plan.rebase).toEqual([{ member: f.m2, from: "s1", to: "main", viaPr: true }]);
  expect(plan.deleteWorkset).toBe(false);
  expect(plan.keepReason).toBe("members remain");
  const text = renderPlan(plan);
  console.info(text);
  expect(text).toContain(`${f.name}:`);
  expect(text).toContain(`  would run in ${f.repo}: git worktree remove ${f.s1.path}`);
  expect(text).toContain("kept ");
  expect(text).toContain("  keep workset: members remain");
  // planning mutated nothing
  expect(hasBranch(f.repo, "s1")).toBe(true);
  expect(existsSync(f.s1.path)).toBe(true);
  expect(loadWorkset(f.name)!.members.length).toBe(3);
});

test("executePrune mixed", () => {
  const f = stacked();
  const plan = planPrune(loadWorkset(f.name)!);
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(true);
  expect(hasBranch(f.repo, "s1")).toBe(false);
  expect(existsSync(f.s1.path)).toBe(false);
  const ws = loadWorkset(f.name)!;
  expect(ws.members.map((m) => m.branch)).toEqual(["s2", "s3"]);
  const s2 = ws.members.find((m) => m.branch === "s2")!;
  expect(s2.base).toBe("main");
  expect(s2.base_source).toBe("pr");
  expect(lines.length).toBeGreaterThan(0);
});

test("rebase without PR collapses the chain", () => {
  const f = stacked();
  stub({ s1: { pr: pr("MERGED", 1), base: "main", headRefOid: f.s1.tip } }, true); // s2 has no PR now
  const plan = planPrune(loadWorkset(f.name)!);
  expect(plan.rebase).toEqual([{ member: f.m2, from: "s1", to: "main", viaPr: false }]);
  expect(executePrune(plan, () => {})).toBe(true);
  const s2 = loadWorkset(f.name)!.members.find((m) => m.branch === "s2")!;
  expect(s2.base).toBe("main");
  expect(s2.base_source).toBe("inferred");
});

test("planPrune all-dead default workset", () => {
  const d = dead(DEFAULT_NAME);
  const notes = join(sub("reviews"), DEFAULT_NAME, "notes", "n.json");
  writeJson(notes, []);
  writeJson(archiveFile(DEFAULT_NAME, "r1"), { id: "r1" });
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.deleteWorkset).toBe(true);
  expect(plan.keepReason).toBeNull();
  expect(plan.members.map((m) => m.status.member.branch)).toEqual(["done", "ghost"]);
  expect(plan.members[1].cmds).toEqual([]);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
  expect(existsSync(notes)).toBe(false);
  expect(existsSync(archiveFile(DEFAULT_NAME, "r1"))).toBe(true);
  expect(hasBranch(d.repo, "done")).toBe(false);
  expect(existsSync(d.w.path)).toBe(false);
});

test("pointers: stale is closed, closed and stale are deleted, open keeps the workset", () => {
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("o", cwd); transcript(cwd, "o", Date.now());
  pointer("s", cwd); transcript(cwd, "s", Date.now() - 2 * 86400_000); // old transcript: stale
  pointer("c", cwd, { closed: "2026-01-02T00:00:00.000Z" });
  const keys = ["claude-o", "claude-s", "claude-c"];
  for (const k of keys.slice(1)) {
    mkdirSync(join(sub("inbox"), k), { recursive: true });
    writeFileSync(join(sub("inbox"), k, "x.json"), JSON.stringify({ id: "x", read: true }));
    mkdirSync(sub("watch"), { recursive: true });
    writeFileSync(join(sub("watch"), `${k}.pid`), "1");
  }
  const repo = mkRepo("ptr");
  saveWorkset(wsOf(DEFAULT_NAME, [mem(repo, "ghost")], keys));
  let plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.pointers.close.map((p) => p.key)).toEqual(["claude-s"]);
  expect(plan.pointers.delete.map((p) => p.key).sort()).toEqual(["claude-c", "claude-s"]);
  expect(plan.deleteWorkset).toBe(false);
  expect(plan.keepReason).toBe("open session claude-o");

  removeFile(join(sub("sessions"), "claude-o.json"));
  const ws = loadWorkset(DEFAULT_NAME)!;
  ws.sessions = ws.sessions.filter((k) => k !== "claude-o");
  saveWorkset(ws);
  plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.deleteWorkset).toBe(true);
  expect(loadPointer("claude-c")!.closed_reason).toBeUndefined();
  expect(executePrune(plan, () => {})).toBe(true);
  for (const k of ["claude-s", "claude-c"]) {
    expect(existsSync(join(sub("sessions"), `${k}.json`))).toBe(false);
    expect(existsSync(join(sub("inbox"), k))).toBe(false);
    expect(existsSync(join(sub("watch"), `${k}.pid`))).toBe(false);
  }
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
});

test("pointer bound to two worksets is kept", () => {
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  const repo = mkRepo("two");
  saveWorkset(wsOf("other", [mem(repo, "x")]));
  pointer("c", cwd, { closed: "2026-01-02T00:00:00.000Z", workset: "other" });
  saveWorkset(wsOf(DEFAULT_NAME, [], ["claude-c"]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.pointers.delete).toEqual([]);
  // also kept when another workset only lists it in sessions
  saveWorkset(wsOf("third", [], ["claude-c"]));
  pointer("c", cwd, { closed: "2026-01-02T00:00:00.000Z", workset: DEFAULT_NAME });
  expect(planPrune(loadWorkset(DEFAULT_NAME)!).pointers.delete).toEqual([]);
});

test("refused when locked", () => {
  const d = dead(DEFAULT_NAME);
  writeJson(join(sub("locks"), `${DEFAULT_NAME}.json`), { workset: DEFAULT_NAME, review: "r", paths: [], opened: "x", holder: "h" });
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.refused).toBe("locked");
  expect(executePrune(plan, () => {})).toBe(false);
  expect(hasBranch(d.repo, "done")).toBe(true);
  expect(existsSync(d.w.path)).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)).not.toBeNull();
  expect(sweepable().length).toBe(0);
});

test("sweepable", () => {
  dead(DEFAULT_NAME);                                       // default all-dead: in
  const d2 = dead("named-dead", "named-done");                            // named all-dead: out
  void d2;
  stacked(DEFAULT_NAME2);                                   // default mixed: out
  const repo = mkRepo("emp");
  saveWorkset(wsOf("claude-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", []));  // default empty, no pointers: in
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("o", cwd); transcript(cwd, "o", Date.now());
  saveWorkset(wsOf("claude-cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", [], ["claude-o"])); // empty with open pointer: out
  void repo;
  const names = sweepable().map((p) => p.workset).sort();
  expect(names).toContain(DEFAULT_NAME);
  expect(names).toContain("claude-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
  expect(names).not.toContain("named-dead");
  expect(names).not.toContain(DEFAULT_NAME2);
  expect(names).not.toContain("claude-cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("shared stored worktree: removed once, for the member git has checked out there", () => {
  const repo = mkRepo("dup");
  const w = mkWorktree(repo, "one");
  mkBranch(repo, "two", true);
  const twoTip = sh(repo, "rev-parse", "two");
  stub({
    one: { pr: pr("MERGED", 1), base: "main", headRefOid: w.tip },
    two: { pr: pr("MERGED", 2), base: "main", headRefOid: twoTip },
  });
  saveWorkset(wsOf(DEFAULT_NAME, [mem(repo, "one", { worktree: w.path }), mem(repo, "two", { worktree: w.path })]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.members.map((m) => [m.status.member.branch, m.cmds])).toEqual([
    ["one", [`git worktree remove ${w.path}`, `git update-ref -d refs/heads/one ${w.tip}`]],
    ["two", [`git update-ref -d refs/heads/two ${twoTip}`]],
  ]);
  expect(plan.kept).toEqual([]);
  expect(plan.deleteWorkset).toBe(true);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(existsSync(w.path)).toBe(false);
  expect(hasBranch(repo, "one")).toBe(false);
  expect(hasBranch(repo, "two")).toBe(false);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
});

test("a branch checked out in the main checkout gets only the branch delete, which fails", () => {
  const repo = mkRepo("mainco");
  const tip = mkBranch(repo, "mx", true);
  sh(repo, "checkout", "-q", "mx");
  stub({ mx: { pr: pr("MERGED", 1), base: "main", headRefOid: tip } });
  saveWorkset(wsOf("mainco", [mem(repo, "mx", { worktree: repo })]));
  const plan = planPrune(loadWorkset("mainco")!);
  expect(plan.members.map((m) => m.cmds)).toEqual([[`git update-ref -d refs/heads/mx ${tip}`]]);
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(false);
  expect(lines).toContain(`failed in ${repo}: git update-ref -d refs/heads/mx ${tip}`);
  expect(existsSync(repo)).toBe(true);
  expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("mx");
  expect(hasBranch(repo, "mx")).toBe(true);
  expect(loadWorkset("mainco")!.members.map((m) => m.branch)).toEqual(["mx"]);
});

test("a branch whose tip moved after planning is not deleted", () => {
  const repo = mkRepo("moved");
  const tip = mkBranch(repo, "mv", true);
  stub({ mv: { pr: pr("MERGED", 1), base: "main", headRefOid: tip } });
  saveWorkset(wsOf("moved", [mem(repo, "mv")]));
  const plan = planPrune(loadWorkset("moved")!);
  expect(plan.members[0].steps).toEqual({ worktree: null, branch: "mv", sha: tip });
  sh(repo, "checkout", "-q", "mv");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "late");
  sh(repo, "checkout", "-q", "main");
  expect(executePrune(plan, () => {})).toBe(false);
  expect(hasBranch(repo, "mv")).toBe(true);
  expect(sh(repo, "rev-parse", "mv")).not.toBe(tip);
  expect(loadWorkset("moved")!.members.map((m) => m.branch)).toEqual(["mv"]);
});

test("a worktree switched to another branch after planning is not removed", () => {
  const repo = mkRepo("late-switch");
  const w = mkWorktree(repo, "ls");
  mkBranch(repo, "else", true);
  stub({ ls: { pr: pr("MERGED", 1), base: "main", headRefOid: w.tip } });
  saveWorkset(wsOf("lsw", [mem(repo, "ls", { worktree: w.path })]));
  const plan = planPrune(loadWorkset("lsw")!);
  expect(plan.members[0].steps.worktree).toBe(w.path);
  sh(w.path, "switch", "-q", "else");
  expect(executePrune(plan, () => {})).toBe(false);
  expect(existsSync(w.path)).toBe(true);
  expect(hasBranch(repo, "ls")).toBe(true);
});

test("list's prune action and the sweep agree", () => {
  const cases: [string, () => void][] = [
    [DEFAULT_NAME, () => { dead(DEFAULT_NAME); }],
    [DEFAULT_NAME2, () => {
      const repo = mkRepo("agree");
      const w = mkWorktree(repo, "wm");
      mkBranch(repo, "elsewhere", true);
      stub({ wm: { pr: pr("MERGED", 3), base: "main", headRefOid: w.tip } });
      sh(w.path, "switch", "-q", "elsewhere");
      saveWorkset(wsOf(DEFAULT_NAME2, [mem(repo, "wm", { worktree: w.path })]));
    }],
    ["claude-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", () => { saveWorkset(wsOf("claude-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", [])); }],
    [OPEN_NAME, () => {                                    // every member dead, but a bound session is open
      dead(OPEN_NAME, "open-done");
      const cwd = join(tmp, "open-cwd");
      mkdirSync(cwd);
      pointer("live", cwd, { workset: OPEN_NAME }); transcript(cwd, "live", Date.now());
    }],
    [UNREAD_NAME, () => {                                  // every member dead, but a review waits unread
      dead(UNREAD_NAME, "unread-done");
      const ws = loadWorkset(UNREAD_NAME)!;
      ws.sessions = ["claude-reader"];
      saveWorkset(ws);
      writeJson(join(sub("inbox"), "claude-reader", "r1.json"), { id: "r1", read: false });
    }],
  ];
  const expected = [true, true, true, false, false];
  cases.forEach(([name, setup], i) => {
    setup();
    const ws = loadWorkset(name)!;
    const swept = sweepable().some((p) => p.workset === name);
    expect(summarize(ws).action === "prune").toBe(swept);
    expect(swept).toBe(expected[i]);
  });
  expect(summarize(loadWorkset(UNREAD_NAME)!).action).toBe("review");
  expect(planPrune(loadWorkset(UNREAD_NAME)!).refused).toBe("unread review");
  expect(planPrune(loadWorkset(OPEN_NAME)!).keepReason).toBe("open session claude-live");
});

test("prune command: sweep dry run changes nothing, --yes executes", async () => {
  const d = dead(DEFAULT_NAME);
  const dry = await capture(() => worksetRun(["prune"]));
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`${DEFAULT_NAME}:`);
  expect(dry.out).toContain(`would run in ${d.repo}: git worktree remove ${d.w.path}`);
  expect(dry.out).toContain(`git update-ref -d refs/heads/done ${d.w.tip}`);
  expect(dry.out).toContain("delete workset");
  expect(hasBranch(d.repo, "done")).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)).not.toBeNull();
  const yes = await capture(() => worksetRun(["prune", "--yes"]));
  expect(yes.code).toBe(0);
  expect(hasBranch(d.repo, "done")).toBe(false);
  expect(existsSync(d.w.path)).toBe(false);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
});

test("prune command by name: dry run, --yes, and named worksets", async () => {
  const f = stacked("cinf-1");
  const dry = await capture(() => worksetRun(["prune", "cinf-1"]));
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`would run in ${f.repo}:`);
  expect(dry.out).toContain(`kept ${f.m2.id}: open PR`);
  expect(dry.out).toContain(`rebase ${f.m2.id}: s1 -> main`);
  expect(hasBranch(f.repo, "s1")).toBe(true);
  const yes = await capture(() => worksetRun(["prune", "cinf-1", "--yes"]));
  expect(yes.code).toBe(0);
  expect(hasBranch(f.repo, "s1")).toBe(false);
  expect(loadWorkset("cinf-1")!.members.length).toBe(2);
  // a named workset is excluded from the sweep
  const sweep = await capture(() => worksetRun(["prune"]));
  expect(sweep.out).not.toContain("cinf-1");
});

test("prune says so on stderr when gh is down", async () => {
  const repo = mkRepo("ghdown");
  saveWorkset(wsOf("cinf-gh", [mem(repo, "ghost")]));
  const oldPath = process.env.PATH;
  process.env.PATH = join(tmp, "nobin"); // gh cannot run
  try {
    const r = await capture(() => worksetRun(["prune", "cinf-gh"]));
    expect(r.err).toContain("gh not available: PR state from stored members");
  } finally { process.env.PATH = oldPath; }
});

test("prune with a member id now fails as an unknown workset", async () => {
  const r = await capture(() => worksetRun(["prune", "owner/repo#branch", "--yes"]));
  expect(r.code).toBe(1);
  expect(r.err).toContain('workbench: no workset "owner/repo#branch"');
});

test("a git failure keeps the member and the workset, and returns false", () => {
  const d = dead(DEFAULT_NAME);
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  writeFileSync(join(d.w.path, "late.txt"), "x"); // dirtied after planning: git worktree remove refuses
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(false);
  expect(hasBranch(d.repo, "done")).toBe(true);
  expect(existsSync(d.w.path)).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)!.members.map((m) => m.branch)).toEqual(["done"]);
  expect(lines.join("\n")).toContain("failed");
});

test("a member whose stored worktree switched branch gets only the branch delete", () => {
  const repo = mkRepo("sw");
  const w = mkWorktree(repo, "m");
  mkBranch(repo, "other", true);
  stub({ m: { pr: pr("MERGED", 1), base: "main", headRefOid: w.tip } });
  sh(w.path, "switch", "-q", "other");
  saveWorkset(wsOf("sw1", [mem(repo, "m", { worktree: w.path })]));
  const plan = planPrune(loadWorkset("sw1")!);
  expect(plan.members.map((m) => [m.status.reason, m.cmds])).toEqual([["merged", [`git update-ref -d refs/heads/m ${w.tip}`]]]);
  expect(plan.kept).toEqual([]);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(hasBranch(repo, "m")).toBe(false);
  expect(hasBranch(repo, "other")).toBe(true);
  expect(existsSync(w.path)).toBe(true);
  expect(sh(w.path, "symbolic-ref", "--short", "HEAD")).toBe("other");
});

test("a dead member shared with another workset is pruned and removed from that workset", () => {
  const d = dead(DEFAULT_NAME);
  const keepMember = mem(d.repo, "keep-me");
  sh(d.repo, "branch", "keep-me");
  saveWorkset(wsOf("keeper", [d.members[0], keepMember]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.members.map((m) => m.status.member.branch)).toEqual(["done", "ghost"]);
  expect(plan.kept).toEqual([]);
  expect(plan.siblings.map((x) => [x.workset, x.locked, x.remove.map((m) => m.id)])).toEqual([["keeper", false, [d.members[0].id]]]);
  expect(renderPlan(plan)).toContain("  also removes from workset keeper");
  const before = loadWorkset("keeper")!;
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(true);
  expect(hasBranch(d.repo, "done")).toBe(false);
  expect(existsSync(d.w.path)).toBe(false);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
  const after = loadWorkset("keeper")!;
  expect(after.members.map((m) => m.id)).toEqual([keepMember.id]);
  expect(after).toEqual({ ...before, members: [keepMember] });
  expect(lines).toContain(`removed ${d.members[0].id} from workset keeper`);
});

// A stacked pair in one checkout: "sm" merged (pruned from the main workset), "sk" on top of it with no PR.
function siblingFixture(slugStub = true) {
  const repo = mkRepo("sib");
  const w = mkWorktree(repo, "sm");
  sh(repo, "checkout", "-q", "-b", "sk", "sm");
  sh(repo, "commit", "-q", "--allow-empty", "-m", "sk");
  sh(repo, "checkout", "-q", "main");
  const slug = remoteSlug(repo)!;
  const entry = { pr: pr("MERGED", 11), base: "main", headRefOid: w.tip };
  if (slugStub) {
    writeFileSync(join(tmp, "stub.json"), JSON.stringify({ prsForBranches: { [slug]: { sm: entry } } }));
    process.env.WORKBENCH_GH_STUB = join(tmp, "stub.json");
  } else stub({ sm: entry });
  const sm = mem(repo, "sm", { worktree: w.path, base: "main", base_source: "declared" });
  const sk = mem(repo, "sk", { base: "sm", base_source: "inferred" });
  saveWorkset(wsOf("cinf-main", [sm]));
  return { repo, w, sm, sk, slug };
}

test("a sibling workset of the same checkout loses the pruned member and is rebased", () => {
  const f = siblingFixture();
  const extra = mem(f.repo, "elsewhere-x");
  saveWorkset(wsOf("cinf-sib", [{ ...f.sm, worktree: null }, f.sk, extra]));
  const plan = planPrune(loadWorkset("cinf-main")!);
  expect(plan.siblings.map((x) => [x.workset, x.locked, x.remove.map((m) => m.id), x.rebase.map((r) => [r.member.id, r.from, r.to, r.viaPr])]))
    .toEqual([["cinf-sib", false, [f.sm.id], [[f.sk.id, "sm", "main", false]]]]);
  const text = renderPlan(plan);
  expect(text).toContain("  also removes from workset cinf-sib");
  expect(text).toContain(`  also rebases ${f.sk.id} in cinf-sib: sm -> main`);
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(true);
  expect(hasBranch(f.repo, "sm")).toBe(false);
  const after = loadWorkset("cinf-sib")!;
  expect(after.members.map((m) => [m.branch, m.base, m.base_source])).toEqual([["sk", "main", "inferred"], ["elsewhere-x", null, null]]);
  expect(lines).toContain(`rebased ${f.sk.id} in cinf-sib: sm -> main`);
});

test("a sibling member's PR base wins when it has one", () => {
  const f = siblingFixture();
  const stubbed = JSON.parse(readFileSync(join(tmp, "stub.json"), "utf8"));
  stubbed.prsForBranches[f.slug].sk = { pr: pr("OPEN", 12), base: "release", headRefOid: sh(f.repo, "rev-parse", "sk") };
  writeFileSync(join(tmp, "stub.json"), JSON.stringify(stubbed));
  saveWorkset(wsOf("cinf-sib", [f.sm, f.sk]));
  const plan = planPrune(loadWorkset("cinf-main")!);
  expect(plan.siblings[0].rebase.map((r) => [r.to, r.viaPr])).toEqual([["release", true]]);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset("cinf-sib")!.members.map((m) => [m.branch, m.base, m.base_source])).toEqual([["sk", "release", "pr"]]);
});

test("a sibling member of the same slug and branch in another checkout is not matched", () => {
  const f = siblingFixture();
  const clone = join(tmp, "clone");
  sh(tmp, "clone", "-q", join(tmp, "sib-origin.git"), clone);
  sh(clone, "branch", "sm", "origin/sm");
  const other = mem(clone, "sm");
  expect(other.id).toBe(f.sm.id); // same slug#branch
  saveWorkset(wsOf("cinf-clone", [other, mem(clone, "ck", { base: "sm", base_source: "inferred" })]));
  const plan = planPrune(loadWorkset("cinf-main")!);
  expect(plan.siblings).toEqual([]);
  expect(renderPlan(plan)).not.toContain("cinf-clone");
  expect(executePrune(plan, () => {})).toBe(true);
  expect(hasBranch(f.repo, "sm")).toBe(false);
  expect(hasBranch(clone, "sm")).toBe(true);
  expect(loadWorkset("cinf-clone")!.members.map((m) => [m.branch, m.base])).toEqual([["sm", null], ["ck", "sm"]]);
});

test("a locked sibling workset is left untouched and reported", () => {
  const f = siblingFixture();
  saveWorkset(wsOf("cinf-locked", [f.sm, f.sk]));
  writeJson(join(sub("locks"), "cinf-locked.json"), { workset: "cinf-locked", review: "r", paths: [], opened: "x", holder: "h" });
  const before = loadWorkset("cinf-locked")!;
  const plan = planPrune(loadWorkset("cinf-main")!);
  expect(plan.siblings.map((x) => [x.workset, x.locked])).toEqual([["cinf-locked", true]]);
  const text = renderPlan(plan);
  expect(text).toContain("  sibling cinf-locked locked; not updated");
  expect(text).not.toContain("also removes from workset cinf-locked");
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(true);
  expect(lines).toContain("sibling cinf-locked locked; not updated");
  expect(loadWorkset("cinf-locked")).toEqual(before);
});

test("a pointer that came back to life before execute is left alone", () => {
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("s", cwd); transcript(cwd, "s", Date.now() - 2 * 86400_000);
  const repo = mkRepo("rev");
  saveWorkset(wsOf(DEFAULT_NAME, [mem(repo, "ghost")], ["claude-s"]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.deleteWorkset).toBe(true);
  transcript(cwd, "s", Date.now());
  expect(executePrune(plan, () => {})).toBe(true);
  expect(existsSync(join(sub("sessions"), "claude-s.json"))).toBe(true);
  expect(loadPointer("claude-s")!.closed).toBeNull();
  expect(loadWorkset(DEFAULT_NAME)).not.toBeNull();
});

test("a workset that gained a member before execute is not deleted", () => {
  const d = dead(DEFAULT_NAME);
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  const ws = loadWorkset(DEFAULT_NAME)!;
  ws.members.push(mem(d.repo, "late"));
  saveWorkset(ws);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)!.members.map((m) => m.branch)).toEqual(["late"]);
});

test("execute keeps the workset and every pointer file when a session is open", () => {
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("o", cwd); transcript(cwd, "o", Date.now());
  pointer("s", cwd); transcript(cwd, "s", Date.now() - 2 * 86400_000);
  pointer("c", cwd, { closed: "2026-01-02T00:00:00.000Z" });
  const repo = mkRepo("op");
  saveWorkset(wsOf(DEFAULT_NAME, [mem(repo, "ghost")], ["claude-o", "claude-s", "claude-c"]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.keepReason).toBe("open session claude-o");
  expect(executePrune(plan, () => {})).toBe(true);
  for (const k of ["claude-o", "claude-s", "claude-c"]) expect(existsSync(join(sub("sessions"), `${k}.json`))).toBe(true);
  expect(loadPointer("claude-s")!.closed_reason).toBe("stale");
  expect(loadWorkset(DEFAULT_NAME)!.members).toEqual([]);
});

test("a chain of two pruned members collapses onto the first surviving base", () => {
  const repo = mkRepo("chain");
  const a = mkWorktree(repo, "c1");
  const b = mkWorktree(repo, "c2");
  mkBranch(repo, "c3", false);
  stub({
    c1: { pr: pr("MERGED", 1), base: "main", headRefOid: a.tip },
    c2: { pr: pr("MERGED", 2), base: "c1", headRefOid: b.tip },
  });
  saveWorkset(wsOf("chain", [
    mem(repo, "c1", { worktree: a.path, base: "main" }),
    mem(repo, "c2", { worktree: b.path, base: "c1" }),
    mem(repo, "c3", { base: "c2", base_source: "inferred" }),
  ]));
  const plan = planPrune(loadWorkset("chain")!);
  expect(plan.rebase.map((r) => [r.from, r.to])).toEqual([["c2", "main"]]);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset("chain")!.members.map((m) => [m.branch, m.base])).toEqual([["c3", "main"]]);
});

test("removeInbox and removePidFile refuse an empty or path-like key", () => {
  mkdirSync(join(sub("inbox"), "claude-x"), { recursive: true });
  removeInbox(""); removeInbox("../inbox"); removePidFile("");
  expect(existsSync(join(sub("inbox"), "claude-x"))).toBe(true);
});

test("workset rename: prints old -> new; wrong arity is a usage error", async () => {
  saveWorkset({ name: "a", created: "2026-01-01T00:00:00Z", members: [], sessions: [], ignored: [] });
  const ok = await capture(() => worksetRun(["rename", "a", "b"]));
  expect(ok).toMatchObject({ code: 0, out: "a -> b" });
  expect(loadWorkset("b")!.name).toBe("b");
  expect((await capture(() => worksetRun(["rename", "a"]))).code).toBe(2);
  const miss = await capture(() => worksetRun(["rename", "a", "c"]));
  expect(miss.code).toBe(1);
  expect(miss.err).toBe('workbench: no workset "a"');
});
