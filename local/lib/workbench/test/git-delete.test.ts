import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBranchAt, worktreeList } from "../src/git";

const ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
const shOk = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" }).exitCode === 0;

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

test("deleteBranchAt deletes a branch checked out nowhere at its tip", () => {
  sh(repo, "branch", "x");
  expect(deleteBranchAt(repo, "x", sh(repo, "rev-parse", "x"))).toBe(true);
  expect(sh(repo, "branch", "--list", "x")).toBe("");
});

test("worktreeList is null and deleteBranchAt refuses when the worktree list cannot be read", () => {
  sh(repo, "branch", "x");
  const tip = sh(repo, "rev-parse", "x");
  const notRepo = join(tmp, "plain");
  mkdirSync(notRepo);
  expect(worktreeList(notRepo)).toBeNull();
  expect(deleteBranchAt(notRepo, "x", tip)).toBe(false);
  expect(sh(repo, "rev-parse", "x")).toBe(tip);
});

test("deleteBranchAt refuses a branch checked out in the main checkout", () => {
  sh(repo, "checkout", "-q", "-b", "x");
  expect(deleteBranchAt(repo, "x", sh(repo, "rev-parse", "x"))).toBe(false);
  expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("x");
});

test("deleteBranchAt refuses a branch being rebased in a worktree", () => {
  sh(repo, "checkout", "-q", "-b", "other");
  writeFileSync(join(repo, "f.txt"), "other\n");
  sh(repo, "commit", "-q", "-am", "other");
  sh(repo, "checkout", "-q", "main");
  const wt = join(tmp, "wt");
  sh(repo, "worktree", "add", "-q", "-b", "x", wt, "main");
  writeFileSync(join(wt, "f.txt"), "x\n");
  sh(wt, "commit", "-q", "-am", "x");
  const tip = sh(repo, "rev-parse", "x");
  expect(shOk(wt, "rebase", "other")).toBe(false); // conflicts: HEAD detached, rebase-merge present
  expect(existsSync(join(sh(wt, "rev-parse", "--absolute-git-dir"), "rebase-merge"))).toBe(true);
  expect(deleteBranchAt(repo, "x", tip)).toBe(false);
  expect(sh(repo, "rev-parse", "x")).toBe(tip);
});
