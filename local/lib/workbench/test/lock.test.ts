import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { writeJson } from "../src/store";
import { sub } from "../src/paths";
import { activeLocks, commandTouches, looksLikeWrite } from "../src/lock";

let root: string, locked: string, other: string;

function lock(ws: string, paths: string[], holder = "jake") {
  writeJson(join(sub("locks"), `${ws}.json`), { workset: ws, review: "r1", paths, opened: "t", holder });
}
const write = (path: string, cwd = other, tool = "Edit") => handle({ kind: "beforeWrite", harness: "claude", session: "s", cwd, path, tool });
const cmd = (command: string, cwd = other) => handle({ kind: "beforeCommand", harness: "claude", session: "s", cwd, command });

beforeEach(() => {
  process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-"));
  delete process.env.WORKBENCH_SESSION; delete process.env.CLAUDE_CODE_SESSION_ID;
  root = realpathSync(mkdtempSync(join(tmpdir(), "wbl-")));
  locked = join(root, "a/b"); other = join(root, "elsewhere");
  mkdirSync(locked, { recursive: true }); mkdirSync(other, { recursive: true });
  mkdirSync(join(root, "a/bc"), { recursive: true });
  writeFileSync(join(locked, "f.txt"), "x");
  lock("spike", [locked]);
});

test("Edit under a locked worktree is denied with the holder", () => {
  const out = write("f.txt", locked);
  expect(out.deny).toBe(`workbench: ${locked} is locked by review r1 of workset spike (held by jake); it is released on submit or close. Work elsewhere until then.`);
});
test("Write and NotebookEdit are denied like Edit", () => {
  expect(write(join(locked, "n.ipynb"), other, "NotebookEdit").deny).toContain("locked by review r1");
  expect(write(join(locked, "new.txt"), other, "Write").deny).toContain("locked by review r1");
});
test("Edit outside is allowed", () => {
  expect(write(join(other, "x"))).toEqual({});
});
test("a lock on /a/b does not match /a/bc", () => {
  expect(write(join(root, "a/bc/x"))).toEqual({});
  expect(commandTouches("rm x", join(root, "a/bc"), [locked])).toBeNull();
});
test("Bash git commit with cwd inside a locked worktree is denied", () => {
  expect(cmd("git commit -m x", locked).deny).toContain(locked);
});
test("Bash git status inside a locked worktree is allowed", () => {
  expect(cmd("git status", locked)).toEqual({});
});
test("Bash cd <locked> && sed -i is denied", () => {
  expect(cmd(`cd ${locked} && sed -i s/a/b/ f.txt`).deny).toContain("locked by review");
});
test("Bash that names a locked path with > redirection is denied", () => {
  expect(cmd(`echo hi > ${locked}/f.txt`).deny).toContain("locked by review");
});
test("Bash that only cats a locked file is allowed", () => {
  expect(cmd(`cat ${locked}/f.txt`)).toEqual({});
});
test("redirect to /dev/null inside a lock is allowed; 2>&1 too", () => {
  expect(cmd("echo x > /dev/null", locked)).toEqual({});
  expect(cmd("ls 2>/dev/null", locked)).toEqual({});
  expect(cmd("ls 2>&1", locked)).toEqual({});
});
test("a write-looking command outside every lock is allowed", () => {
  expect(cmd("git commit -m x", other)).toEqual({});
});
test("git -C <locked> commit is denied", () => {
  expect(cmd(`git -C ${locked} commit -m x`).deny).toContain("locked by review");
});
test("relative cd tracks effective cwd", () => {
  expect(cmd("cd ../a/b && rm f.txt", other).deny).toContain("locked by review");
  expect(cmd(`cd ${other} && cd .. && rm f.txt`, other)).toEqual({});
  // any effective cwd along the way counts, even one the command later leaves
  expect(cmd(`cd ${locked} && cd ${other} && rm f.txt`, other).deny).toContain("locked by review");
});
test("prompt submitted while a lock exists injects a context line naming the workset", () => {
  lock("two", [other]);
  const out = handle({ kind: "promptSubmitted", harness: "claude", session: "s", cwd: other });
  expect(out.context).toContain(`workbench: review open on workset spike; worktrees ${locked} are locked until submit or close. Do not edit there.`);
  expect(out.context!.split("\n").length).toBe(2);
});
test("no lock means no context", () => {
  process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-"));
  expect(handle({ kind: "promptSubmitted", harness: "claude", session: "s", cwd: other })).toEqual({});
});
test("a corrupt lock file is skipped", () => {
  writeFileSync(join(sub("locks"), "bad.json"), "{nope");
  writeFileSync(join(sub("locks"), "odd.json"), JSON.stringify({ workset: "odd" }));
  expect(activeLocks().map((l) => l.workset)).toEqual(["spike"]);
  expect(write("f.txt", locked).deny).toBeDefined();
});
test("looksLikeWrite basics", () => {
  expect(looksLikeWrite("git status")).toBe(false);
  expect(looksLikeWrite("git push origin x")).toBe(true);
  expect(looksLikeWrite("echo a >> f")).toBe(true);
});

test("read-only commands inside a lock are allowed", () => {
  for (const c of ["git diff src/rm.ts", "git log --format=%cp", "npm run cp-assets", "grep -rn 'tee' src", "ls -la src/cp",
    "awk '$1 >= 3' f", "grep '>' f", "jq '.[] | select(.n > 1)' f", "git stash list"]) {
    expect({ c, out: cmd(c, locked) }).toEqual({ c, out: {} });
  }
});
test("write commands inside a lock are still denied", () => {
  for (const c of ["FOO=1 rm -rf x", "sudo chmod +x f", "xargs rm", "git -C . commit -m x", "git stash", "git stash pop",
    "sed -n 1p f > out", `echo "a > b" > out`]) {
    expect({ c, denied: cmd(c, locked).deny !== undefined }).toEqual({ c, denied: true });
  }
});
