import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeList } from "../src/git";

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
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-del-")));
  repo = join(tmp, "r");
  sh(tmp, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "f.txt"), "base\n");
  sh(repo, "add", "f.txt");
  sh(repo, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("worktreeList is null when the worktree list cannot be read", () => {
  const notRepo = join(tmp, "plain");
  mkdirSync(notRepo);
  expect(worktreeList(notRepo)).toBeNull();
  expect(worktreeList(repo)).not.toBeNull();
});
