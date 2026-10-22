import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { useWorkset } from "../src/session";
import { addMember, loadWorkset, saveWorkset } from "../src/workset";
import { sub } from "../src/paths";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
}
let root: string;
let repo: string;
let n = 0;
beforeEach(() => {
  process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-"));
  process.env.WORKBENCH_CONFIG = join(process.env.WORKBENCH_STATE_DIR, "none.toml");
  delete process.env.WORKBENCH_SESSION; delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.WORKBENCH_GH_STUB;
  root = realpathSync(mkdtempSync(join(tmpdir(), "wb-repo-")));
  repo = join(root, "main");
  sh(root, "git", "init", "-b", "main", repo);
  sh(repo, "git", "remote", "add", "origin", "git@github.com:o/r.git");
  sh(repo, "git", "commit", "--allow-empty", "-m", "init");
  handle({ kind: "sessionStarted", harness: "claude", session: "s1", cwd: repo, resumed: false });
  useWorkset("claude-s1", "spike");
});

// Runs `act` between the before and after events of one Bash call whose text is `command`.
function bash(command: string, cwd: string, act: () => void) {
  const toolUseId = `t${++n}`;
  handle({ kind: "beforeCommand", harness: "claude", session: "s1", cwd, command, toolUseId });
  act();
  handle({ kind: "afterCommand", harness: "claude", session: "s1", cwd, command, output: "", toolUseId });
}
const members = () => loadWorkset("spike")!.members;

test("a branch created inside a shell loop is recorded, whatever the command text says", () => {
  bash("for b in a; do git branch feat/$b; done", repo, () => sh(repo, "git", "branch", "feat/a"));
  expect(members()).toHaveLength(1);
  expect(members()[0]).toMatchObject({ repo, slug: "o/r", branch: "feat/a", worktree: null, added_by: "claude-s1" });
});

test("a new worktree is recorded with its path, even when a script made it", () => {
  const wt = join(root, "wt");
  bash("./make-worktree.sh", repo, () => sh(repo, "git", "worktree", "add", wt, "-b", "feat/x"));
  expect(members()[0]).toMatchObject({ branch: "feat/x", worktree: wt });
});

test("commits on the default branch are not recorded", () => {
  bash("git commit --allow-empty -m x", repo, () => sh(repo, "git", "commit", "--allow-empty", "-m", "x"));
  expect(members()).toEqual([]);
});

test("a detached worktree is not recorded", () => {
  bash("git worktree add ../review HEAD", repo, () => sh(repo, "git", "worktree", "add", "--detach", join(root, "review")));
  expect(members()).toEqual([]);
});

test("switching an existing worktree to an existing branch does not record it", () => {
  sh(repo, "git", "branch", "colleague/topic");
  const wt = join(root, "wt");
  sh(repo, "git", "worktree", "add", wt, "-b", "scratch");
  bash("git switch colleague/topic", wt, () => sh(wt, "git", "switch", "colleague/topic"));
  expect(members()).toEqual([]);
});

test("a repo named in the command is observed when the cwd is elsewhere", () => {
  bash(`git -C ${repo} branch feat/c`, root, () => sh(repo, "git", "branch", "feat/c"));
  expect(members().map((m) => m.branch)).toEqual(["feat/c"]);
});

test("a hand-declared member gets its worktree filled in instead of a duplicate", () => {
  sh(repo, "git", "branch", "feat/h");
  const ws = loadWorkset("spike")!;
  addMember(ws, { repo, branch: "feat/h", added_by: "hand", base: "main", base_source: "declared", order: 1 });
  saveWorkset(ws);
  const wt = join(root, "wt-h");
  bash(`git worktree add ${wt} feat/h`, repo, () => sh(repo, "git", "worktree", "add", wt, "feat/h"));
  expect(members()).toHaveLength(1);
  expect(members()[0]).toMatchObject({ slug: null, branch: "feat/h", worktree: wt, base: "main", base_source: "declared", order: 1, added_by: "hand" });
});

test("bases are inferred from the nearest member the branch descends from", () => {
  const wt = join(root, "wt");
  bash("stack it", repo, () => {
    sh(repo, "git", "worktree", "add", wt, "-b", "s/one");
    sh(wt, "git", "commit", "--allow-empty", "-m", "one");
    sh(wt, "git", "switch", "-c", "s/two");
    sh(wt, "git", "commit", "--allow-empty", "-m", "two");
    sh(wt, "git", "switch", "-c", "s/three");
    sh(wt, "git", "commit", "--allow-empty", "-m", "three");
  });
  const by = Object.fromEntries(members().map((m) => [m.branch, m]));
  expect(by["s/one"]).toMatchObject({ base: null, base_source: null });
  expect(by["s/two"]).toMatchObject({ base: "s/one", base_source: "inferred" });
  expect(by["s/three"]).toMatchObject({ base: "s/two", base_source: "inferred" });
});

test("an inferred base is never written over a declared one", () => {
  sh(repo, "git", "branch", "s/one");
  sh(repo, "git", "commit", "--allow-empty", "-m", "on main");
  const ws = loadWorkset("spike")!;
  addMember(ws, { repo, branch: "s/one", added_by: "hand" });
  addMember(ws, { repo, branch: "s/two", added_by: "hand", base: "main", base_source: "declared" });
  saveWorkset(ws);
  bash("git branch s/two s/one && commit", repo, () => {
    sh(repo, "git", "branch", "s/two", "s/one");
    const wt = join(root, "wt2");
    sh(repo, "git", "worktree", "add", wt, "s/two");
    sh(wt, "git", "commit", "--allow-empty", "-m", "two");
  });
  expect(members().find((m) => m.branch === "s/two")).toMatchObject({ base: "main", base_source: "declared" });
});

test("ignored items are not recorded", () => {
  const ws = loadWorkset("spike")!;
  ws.ignored.push("o/r#feat/i");
  saveWorkset(ws);
  bash("git branch feat/i", repo, () => sh(repo, "git", "branch", "feat/i"));
  expect(members()).toEqual([]);
});

test("removing a worktree clears it; deleting the branch too removes the member", () => {
  const wt = join(root, "wt");
  bash("add", repo, () => sh(repo, "git", "worktree", "add", wt, "-b", "feat/gone"));
  bash("git worktree remove", repo, () => sh(repo, "git", "worktree", "remove", wt));
  expect(members()[0]).toMatchObject({ branch: "feat/gone", worktree: null });
  bash("git branch -D", repo, () => sh(repo, "git", "branch", "-D", "feat/gone"));
  expect(members()).toEqual([]);
});

test("snapshots are cleaned up, and an after without a before is a no-op", () => {
  bash("git branch feat/s", repo, () => sh(repo, "git", "branch", "feat/s"));
  expect(readdirSync(sub("snapshots"))).toEqual([]);
  expect(handle({ kind: "afterCommand", harness: "claude", session: "s1", cwd: repo, command: "x", output: "", toolUseId: "never" })).toEqual({});
});

test("a command outside any repo takes no snapshot", () => {
  bash("ls", root, () => {});
  expect(existsSync(sub("snapshots")) ? readdirSync(sub("snapshots")) : []).toEqual([]);
  expect(members()).toEqual([]);
});
