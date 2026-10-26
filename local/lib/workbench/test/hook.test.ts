import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { useWorkset } from "../src/session";
import { createWorkset, deleteWorkset, loadWorkset, listWorksets } from "../src/workset";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
}
let repo: string;
let wt: string;
beforeEach(() => {
  process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-"));
  delete process.env.WORKBENCH_SESSION; delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.WORKBENCH_GH_STUB;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-repo-")));
  repo = join(root, "main");
  sh(root, "git", "init", "-b", "main", repo);
  sh(repo, "git", "remote", "add", "origin", "git@github.com:o/r.git");
  sh(repo, "git", "commit", "--allow-empty", "-m", "init");
  wt = join(root, "wt");
  sh(repo, "git", "worktree", "add", wt, "-b", "feat/x");
  handle({ kind: "sessionStarted", harness: "claude", session: "s1", cwd: repo, resumed: false });
  createWorkset("spike");
  useWorkset("claude-s1", "spike");
});
const before = (command: string, cwd: string, toolUseId?: string) => handle({ kind: "beforeCommand", harness: "claude", session: "s1", cwd, command, toolUseId });
const after = (command: string, cwd: string, output = "", toolUseId?: string) => handle({ kind: "afterCommand", harness: "claude", session: "s1", cwd, command, output, toolUseId });

test("an unbound session records nothing", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "s2", cwd: repo, resumed: false });
  handle({ kind: "afterCommand", harness: "claude", session: "s2", cwd: wt, command: "git push -u origin feat/x", output: "" });
  expect(listWorksets()).toEqual(["spike"]);
});
test("a branch created during a bound session's command does not join the workset", () => {
  const cmd = `git worktree add ${join(repo, "..", "wt2")} -b feat/y`;
  before(cmd, repo, "toolu_1");
  sh(repo, "git", "worktree", "add", join(repo, "..", "wt2"), "-b", "feat/y");
  after(cmd, repo, "", "toolu_1");
  expect(loadWorkset("spike")!.members).toEqual([]);
  expect(existsSync(join(process.env.WORKBENCH_STATE_DIR!, "snapshots"))).toBe(false);
});
test("git push -u does not join the branch to the workset", () => {
  after("git push -u origin feat/x", wt);
  after("rtk git push -u origin feat/x", wt);
  expect(loadWorkset("spike")!.members).toEqual([]);
});
test("gh pr create does not join the branch or its PR to the workset", () => {
  const stub = join(process.env.WORKBENCH_STATE_DIR!, "gh.json");
  const pr = { number: 12, url: "https://github.com/o/r/pull/12", draft: true, state: "OPEN" };
  writeFileSync(stub, JSON.stringify({ prForBranch: { pr, base: "main" } }));
  process.env.WORKBENCH_GH_STUB = stub;
  after("gh pr create --draft", wt, "https://github.com/o/r/pull/12\n");
  expect(loadWorkset("spike")!.members).toEqual([]);
});
test("a hand-declared member is left exactly as declared", () => {
  const ws = loadWorkset("spike")!;
  ws.members.push({ id: "o/r#feat/x", repo, slug: "o/r", branch: "feat/x", worktree: null, base: null, base_source: null, pr: null, order: null, role: "work", added_by: "hand", added_at: "t", paths: null });
  writeFileSync(join(process.env.WORKBENCH_STATE_DIR!, "worksets", "spike.json"), JSON.stringify(ws));
  const cmd = "git commit --allow-empty -m x";
  before(cmd, wt, "toolu_2");
  sh(wt, "git", "commit", "--allow-empty", "-m", "x");
  after(cmd, wt, "", "toolu_2");
  expect(loadWorkset("spike")!.members[0]).toMatchObject({ worktree: null, base: null, base_source: null });
});
test("a bound session whose workset was deleted does not recreate it", () => {
  deleteWorkset("spike");
  after("git push -u origin feat/x", wt);
  expect(listWorksets()).toEqual([]);
});
test("no pointer for the session returns {} and creates nothing", () => {
  const before = listWorksets();
  expect(handle({ kind: "afterCommand", harness: "claude", session: "nope", cwd: wt, command: "git push -u origin feat/x", output: "" })).toEqual({});
  expect(listWorksets()).toEqual(before);
});
