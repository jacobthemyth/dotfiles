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
import { planPrune, planDelete, executePrune, pruneAll, renderPlan } from "../src/prune";
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

// A pushed branch with no PR and commits not in main: neither dead nor live, so an anonymous workset forgets it.
function pushedOnly(repo: string, branch: string): Member {
  mkBranch(repo, branch, true);
  return mem(repo, branch);
}
const branches = (plan: ReturnType<typeof planPrune>, key: "dropped" | "forgotten" | "kept") => plan[key].map((s) => s.member.branch);

test("planPrune on a named mixed workset drops the merged record, keeps the rest, re-points the base, and plans no git", () => {
  const f = stacked();
  const plan = planPrune(loadWorkset(f.name)!);
  expect(plan.refused).toBeNull();
  expect(branches(plan, "dropped")).toEqual(["s1"]);
  expect(branches(plan, "forgotten")).toEqual([]);
  expect(plan.kept.map((k) => [k.member.branch, k.reason])).toEqual([["s2", "open PR"], ["s3", "unmerged work"]]);
  expect(plan.rebase).toEqual([{ member: f.m2, from: "s1", to: "main", viaPr: true }]);
  expect(plan.deleteWorkset).toBe(false);
  expect(plan.keepReason).toBe("members remain");
  const text = renderPlan(plan);
  expect(text).toContain(`${f.name}:`);
  expect(text).toContain(`  drop ${f.m1.id}: merged`);
  expect(text).toContain(`  kept ${f.m2.id}: open PR`);
  expect(text).toContain(`  rebase ${f.m2.id}: s1 -> main`);
  expect(text).toContain("  keep workset: members remain");
  expect(text).toContain(`  branches left for git cleanup in ${f.repo}`);
  expect(text).not.toMatch(/git (worktree|update-ref|branch)/);
  // planning mutated nothing
  expect(hasBranch(f.repo, "s1")).toBe(true);
  expect(existsSync(f.s1.path)).toBe(true);
  expect(loadWorkset(f.name)!.members.length).toBe(3);
});

test("executePrune drops the record and leaves the branch and worktree in place", () => {
  const f = stacked();
  const plan = planPrune(loadWorkset(f.name)!);
  const lines: string[] = [];
  expect(executePrune(plan, (l) => lines.push(l))).toBe(true);
  expect(hasBranch(f.repo, "s1")).toBe(true);
  expect(existsSync(f.s1.path)).toBe(true);
  expect(sh(f.s1.path, "symbolic-ref", "--short", "HEAD")).toBe("s1");
  const ws = loadWorkset(f.name)!;
  expect(ws.members.map((m) => m.branch)).toEqual(["s2", "s3"]);
  const s2 = ws.members.find((m) => m.branch === "s2")!;
  expect(s2.base).toBe("main");
  expect(s2.base_source).toBe("pr");
  expect(lines).toContain(`dropped ${f.m1.id}: merged`);
  expect(lines).toContain(`rebased ${f.m2.id}: s1 -> main`);
  expect(lines.join("\n")).not.toMatch(/git (worktree|update-ref|branch)/);
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

test("an anonymous workset of dead records is deleted; its branches and worktrees stay", () => {
  const d = dead(DEFAULT_NAME);
  const notes = join(sub("reviews"), DEFAULT_NAME, "notes", "n.json");
  writeJson(notes, []);
  writeJson(archiveFile(DEFAULT_NAME, "r1"), { id: "r1" });
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.deleteWorkset).toBe(true);
  expect(plan.keepReason).toBeNull();
  expect(branches(plan, "dropped")).toEqual(["done", "ghost"]);
  expect(plan.dropped.map((s) => s.reason)).toEqual(["merged", "branch gone"]);
  const text = renderPlan(plan);
  expect(text).toContain("  delete workset");
  expect(text).toContain(`  branches left for git cleanup in ${d.repo}`);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
  expect(existsSync(notes)).toBe(false);
  expect(existsSync(archiveFile(DEFAULT_NAME, "r1"))).toBe(true);
  expect(hasBranch(d.repo, "done")).toBe(true);
  expect(existsSync(d.w.path)).toBe(true);
});

test("a session-named workset is an ordinary workset: records that are neither dead nor live are kept, never forgotten", () => {
  const repo = mkRepo("forget");
  const w = mkWorktree(repo, "fm");
  stub({ fm: { pr: pr("MERGED", 5), base: "main", headRefOid: w.tip } });
  const pushed = pushedOnly(repo, "pushed");
  saveWorkset(wsOf(DEFAULT_NAME, [mem(repo, "fm", { worktree: w.path }), pushed]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(branches(plan, "dropped")).toEqual(["fm"]);
  expect(plan.forgotten).toEqual([]);
  expect(plan.kept.map((s) => [s.member.branch, s.reason])).toEqual([["pushed", "unmerged work"]]);
  expect(plan.rebase).toEqual([]);
  expect(plan.deleteWorkset).toBe(false);
  expect(plan.keepReason).toBe("members remain");
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)!.members.map((m) => m.branch)).toEqual(["pushed"]);
  expect(hasBranch(repo, "fm")).toBe(true);
});

test("a workset with a live member keeps every record but the dead ones", () => {
  const f = stacked(DEFAULT_NAME2); // s2 has an open PR
  const plan = planPrune(loadWorkset(DEFAULT_NAME2)!);
  expect(branches(plan, "dropped")).toEqual(["s1"]);
  expect(branches(plan, "forgotten")).toEqual([]);
  expect(branches(plan, "kept")).toEqual(["s2", "s3"]);
  expect(plan.deleteWorkset).toBe(false);
  expect(plan.keepReason).toBe("members remain");
  const text = renderPlan(plan);
  expect(text).toContain("  keep workset: members remain");
  expect(text).toContain(`  kept ${f.m2.id}: open PR\n`);                 // the reason already says why it is live
  expect(text).toContain(`  kept ${f.m3.id}: unmerged work, unpushed\n`); // the reason alone would not
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME2)!.members.map((m) => m.branch)).toEqual(["s2", "s3"]);
  expect(hasBranch(f.repo, "s1")).toBe(true);
});

test("a named workset keeps a record that is neither dead nor live", () => {
  const repo = mkRepo("namedkeep");
  const pushed = pushedOnly(repo, "np");
  saveWorkset(wsOf("cinf-keep", [pushed, mem(repo, "ghost")]));
  const plan = planPrune(loadWorkset("cinf-keep")!);
  expect(branches(plan, "dropped")).toEqual(["ghost"]);
  expect(plan.kept.map((s) => [s.member.branch, s.reason])).toEqual([["np", "unmerged work"]]);
  expect(plan.forgotten).toEqual([]);
  expect(plan.deleteWorkset).toBe(false);
  expect(plan.keepReason).toBe("members remain");
});

test("a dead record listed in another workset leaves only the pruned one", () => {
  const d = dead(DEFAULT_NAME);
  const keepMember = mem(d.repo, "keep-me");
  sh(d.repo, "branch", "keep-me");
  saveWorkset(wsOf("keeper", [d.members[0], keepMember]));
  const before = loadWorkset("keeper")!;
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(renderPlan(plan)).not.toContain("keeper");
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
  expect(loadWorkset("keeper")).toEqual(before);
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

test("an open session is reported as the keep reason only once no member remains", () => {
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("o", cwd); transcript(cwd, "o", Date.now());
  const repo = mkRepo("openkeep");
  const pushed = pushedOnly(repo, "op");
  saveWorkset(wsOf(DEFAULT_NAME, [pushed, mem(repo, "ghost")], ["claude-o"]));
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(branches(plan, "dropped")).toEqual(["ghost"]);
  expect(branches(plan, "kept")).toEqual(["op"]);
  expect(plan.forgotten).toEqual([]);
  expect(plan.keepReason).toBe("members remain");
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)!.members.map((m) => m.branch)).toEqual(["op"]);
  saveWorkset(wsOf(DEFAULT_NAME, [mem(repo, "ghost")], ["claude-o"]));
  expect(planPrune(loadWorkset(DEFAULT_NAME)!).keepReason).toBe("open session claude-o");
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
  dead(DEFAULT_NAME);
  writeJson(join(sub("locks"), `${DEFAULT_NAME}.json`), { workset: DEFAULT_NAME, review: "r", paths: [], opened: "x", holder: "h" });
  const plan = planPrune(loadWorkset(DEFAULT_NAME)!);
  expect(plan.refused).toBe("locked");
  expect(executePrune(plan, () => {})).toBe(false);
  expect(loadWorkset(DEFAULT_NAME)!.members.length).toBe(2);
  expect(pruneAll().length).toBe(0);
});

test("pruneAll plans every workset that would drop a record or be deleted, and skips no-ops and refusals", () => {
  dead(DEFAULT_NAME);                                       // all-dead: in (deleted)
  dead("named-dead", "named-done");                         // all-dead, any name: in (deleted)
  stacked(DEFAULT_NAME2);                                   // a dead record beside live ones: in (dropped, kept)
  const repo = mkRepo("emp");
  const KEEP_NAME = "claude-dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee";
  saveWorkset(wsOf(KEEP_NAME, [pushedOnly(repo, "sw-pushed")]));           // nothing dead, nothing live: out (no-op)
  saveWorkset(wsOf("claude-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", []));  // empty, no pointers: in (deleted)
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("o", cwd); transcript(cwd, "o", Date.now());
  saveWorkset(wsOf("claude-cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee", [], ["claude-o"])); // empty with open pointer: out
  const plans = pruneAll();
  const names = plans.map((p) => p.workset).sort();
  expect(names).toEqual([DEFAULT_NAME, DEFAULT_NAME2, "claude-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", "named-dead"].sort());
  expect(plans.find((p) => p.workset === DEFAULT_NAME2)!.deleteWorkset).toBe(false);
  expect(plans.find((p) => p.workset === "named-dead")!.deleteWorkset).toBe(true);
});

test("list's prune action means a prune would delete the workset", () => {
  const cases: [string, () => void][] = [
    [DEFAULT_NAME, () => { dead(DEFAULT_NAME); }],
    [DEFAULT_NAME2, () => {                                // a dead record and a record that is neither dead nor live
      const repo = mkRepo("agree");
      const w = mkWorktree(repo, "wm");
      stub({ wm: { pr: pr("MERGED", 3), base: "main", headRefOid: w.tip } });
      saveWorkset(wsOf(DEFAULT_NAME2, [mem(repo, "wm", { worktree: w.path }), pushedOnly(repo, "agree-pushed")]));
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
    ["claude-eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee", () => { // a live member: kept
      const repo = mkRepo("agree-live");
      mkBranch(repo, "unpushed", false);
      saveWorkset(wsOf("claude-eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee", [mem(repo, "unpushed")]));
    }],
  ];
  const expected = [true, false, true, false, false, false];
  cases.forEach(([name, setup], i) => {
    setup();
    const ws = loadWorkset(name)!;
    const plan = planPrune(ws);
    const deletes = !plan.refused && plan.deleteWorkset;
    expect(summarize(ws).action === "prune").toBe(deletes);
    expect(deletes).toBe(expected[i]);
  });
  expect(summarize(loadWorkset(UNREAD_NAME)!).action).toBe("review");
  expect(planPrune(loadWorkset(UNREAD_NAME)!).refused).toBe("unread review");
  expect(planPrune(loadWorkset(OPEN_NAME)!).keepReason).toBe("open session claude-live");
  expect(summarize(loadWorkset("claude-eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee")!).action).toBe("-");
});

test("prune command with no name: dry run changes nothing, --yes executes and runs no git", async () => {
  const d = dead(DEFAULT_NAME);
  const dry = await capture(() => worksetRun(["prune"]));
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`${DEFAULT_NAME}:`);
  expect(dry.out).toContain(`drop ${d.members[0].id}: merged`);
  expect(dry.out).toContain("delete workset");
  expect(dry.out).toContain(`branches left for git cleanup in ${d.repo}`);
  expect(dry.out).not.toMatch(/git (worktree|update-ref|branch)/);
  expect(loadWorkset(DEFAULT_NAME)).not.toBeNull();
  const yes = await capture(() => worksetRun(["prune", "--yes"]));
  expect(yes.code).toBe(0);
  expect(hasBranch(d.repo, "done")).toBe(true);
  expect(existsSync(d.w.path)).toBe(true);
  expect(loadWorkset(DEFAULT_NAME)).toBeNull();
});

test("prune command by name: dry run, --yes; with no name every workset is planned", async () => {
  const f = stacked("cinf-1");
  const all = await capture(() => worksetRun(["prune"]));
  expect(all.out).toContain(`drop ${f.m1.id}: merged`);
  expect(loadWorkset("cinf-1")!.members.length).toBe(3);
  const dry = await capture(() => worksetRun(["prune", "cinf-1"]));
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`drop ${f.m1.id}: merged`);
  expect(dry.out).toContain(`kept ${f.m2.id}: open PR`);
  expect(dry.out).toContain(`rebase ${f.m2.id}: s1 -> main`);
  expect(loadWorkset("cinf-1")!.members.length).toBe(3);
  const yes = await capture(() => worksetRun(["prune", "cinf-1", "--yes"]));
  expect(yes.code).toBe(0);
  expect(hasBranch(f.repo, "s1")).toBe(true);
  expect(loadWorkset("cinf-1")!.members.length).toBe(2);
  // with nothing left to drop, a no-name prune has nothing to say about it
  const again = await capture(() => worksetRun(["prune"]));
  expect(again.out).not.toContain("cinf-1");
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

test("a chain of two dropped members collapses onto the first surviving base", () => {
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

test("planDelete forgets a workset whole, live members included; branches stay", () => {
  const f = stacked(DEFAULT_NAME2); // s1 merged, s2 open PR, s3 unmerged
  const plan = planDelete(loadWorkset(DEFAULT_NAME2)!);
  expect(plan.refused).toBeNull();
  expect(branches(plan, "dropped")).toEqual(["s1"]);
  expect(plan.forgotten.map((s) => [s.member.branch, s.reason])).toEqual([["s2", "open PR"], ["s3", "unmerged work"]]);
  expect(plan.kept).toEqual([]);
  expect(plan.rebase).toEqual([]);
  expect(plan.deleteWorkset).toBe(true);
  expect(renderPlan(plan)).toContain(`  forget ${f.m2.id}: open PR`);
  expect(executePrune(plan, () => {})).toBe(true);
  expect(loadWorkset(DEFAULT_NAME2)).toBeNull();
  expect(hasBranch(f.repo, "s1")).toBe(true);
  expect(hasBranch(f.repo, "s2")).toBe(true);
});

test("planDelete takes a named workset too, and is refused while a session is open on it", () => {
  const f = stacked("cinf-del");
  expect(planDelete(loadWorkset("cinf-del")!).deleteWorkset).toBe(true);
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  pointer("o", cwd, { workset: "cinf-del" }); transcript(cwd, "o", Date.now());
  const plan = planDelete(loadWorkset("cinf-del")!);
  expect(plan.refused).toBe("open session claude-o");
  expect(executePrune(plan, () => {})).toBe(false);
  expect(loadWorkset("cinf-del")!.members.length).toBe(3);
  void f;
});

test("delete command: dry run changes nothing, --yes forgets the workset, unknown name fails", async () => {
  const f = stacked(DEFAULT_NAME2);
  const dry = await capture(() => worksetRun(["delete", DEFAULT_NAME2]));
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(`forget ${f.m2.id}: open PR`);
  expect(dry.out).toContain("delete workset");
  expect(loadWorkset(DEFAULT_NAME2)!.members.length).toBe(3);
  const yes = await capture(() => worksetRun(["delete", DEFAULT_NAME2, "--yes"]));
  expect(yes.code).toBe(0);
  expect(yes.out).toContain("deleted workset");
  expect(loadWorkset(DEFAULT_NAME2)).toBeNull();
  expect(hasBranch(f.repo, "s2")).toBe(true);
  const miss = await capture(() => worksetRun(["delete", "nope", "--yes"]));
  expect(miss.code).toBe(1);
  expect(miss.err).toBe('workbench: no workset "nope"');
  expect((await capture(() => worksetRun(["delete"]))).code).toBe(2);
});
