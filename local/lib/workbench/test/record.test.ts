import { test, expect } from "bun:test";
import { recognise } from "../src/record";

test("git worktree add with -b", () => {
  const r = recognise("/usr/bin/git worktree add .worktrees/x -b feat/x origin/main", "", "/repo");
  expect(r).toEqual([{ kind: "worktree", path: "/repo/.worktrees/x", branch: "feat/x" }]);
});
test("git worktree add detached from a sha has no branch", () => {
  const r = recognise("git worktree add /tmp/worktrees/t 8b5189615f", "", "/repo");
  expect(r[0]).toMatchObject({ kind: "worktree", path: "/tmp/worktrees/t", branch: null });
});
test("git push -u records a push of the branch", () => {
  expect(recognise("git push -u origin feat/x", "", "/repo")[0]).toEqual({ kind: "push", branch: "feat/x" });
  expect(recognise("git push --set-upstream origin feat/y", "", "/repo")[0]).toEqual({ kind: "push", branch: "feat/y" });
});
test("gh pr create takes the url from output", () => {
  const r = recognise("gh pr create --draft --title x", "Creating pull request\nhttps://github.com/o/r/pull/12\n", "/repo");
  expect(r[0]).toEqual({ kind: "pr", prUrl: "https://github.com/o/r/pull/12" });
});
test("compound commands yield several records", () => {
  const r = recognise("git worktree add .worktrees/a -b a && cd .worktrees/a && git push -u origin a", "", "/repo");
  expect(r.map((x) => x.kind)).toEqual(["worktree", "push"]);
});
test("unrelated commands yield nothing", () => {
  expect(recognise("git status", "", "/repo")).toEqual([]);
});
test("a leading rtk token is ignored", () => {
  expect(recognise("rtk git worktree add .worktrees/x -b feat/x", "", "/repo")).toEqual([{ kind: "worktree", path: "/repo/.worktrees/x", branch: "feat/x" }]);
  expect(recognise("rtk gh pr create", "https://github.com/o/r/pull/3", "/repo")).toEqual([{ kind: "pr", prUrl: "https://github.com/o/r/pull/3" }]);
});
