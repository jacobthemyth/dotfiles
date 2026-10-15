import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { loadWorkset, listWorksets } from "../src/workset";

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
});
const after = (command: string, cwd: string, output = "") => handle({ kind: "afterCommand", harness: "claude", session: "s1", cwd, command, output });

test("rtk-prefixed commands are recorded too", () => {
  after("rtk git push -u origin feat/x", wt);
  expect(loadWorkset("claude-s1")!.members).toHaveLength(1);
});
test("git push -u records the branch at the cwd", () => {
  after("git push -u origin feat/x", wt);
  expect(loadWorkset("claude-s1")!.members[0]).toMatchObject({ repo, branch: "feat/x", worktree: wt });
});
test("a push of a branch that does not exist locally records nothing", () => {
  after(`python3 - <<'X'\ns.replace("git push -u origin feat/x", wt)\nX`, wt);
  after("git push -u origin no/such-branch", wt);
  expect(loadWorkset("claude-s1")!.members).toEqual([]);
});
test("gh pr create records the PR using the gh stub", () => {
  const stub = join(process.env.WORKBENCH_STATE_DIR!, "gh.json");
  const pr = { number: 12, url: "https://github.com/o/r/pull/12", draft: true, state: "OPEN" };
  writeFileSync(stub, JSON.stringify({ prForBranch: { pr, base: "main" } }));
  process.env.WORKBENCH_GH_STUB = stub;
  after("gh pr create --draft", wt, "https://github.com/o/r/pull/12\n");
  expect(loadWorkset("claude-s1")!.members[0]).toMatchObject({ branch: "feat/x", pr, base: "main", worktree: wt });
});
test("unrecognised commands change nothing", () => {
  after("git status", repo);
  expect(loadWorkset("claude-s1")!.members).toEqual([]);
});
test("no pointer for the session returns {} and creates nothing", () => {
  const before = listWorksets();
  expect(handle({ kind: "afterCommand", harness: "claude", session: "nope", cwd: wt, command: "git push -u origin feat/x", output: "" })).toEqual({});
  expect(listWorksets()).toEqual(before);
});
