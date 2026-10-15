import { test, expect } from "bun:test";
import { recognise } from "../src/record";

test("git worktree add is no longer parsed: observation records it", () => {
  expect(recognise("git worktree add .worktrees/x -b feat/x origin/main", "")).toEqual([]);
});
test("git push -u records a push of the branch", () => {
  expect(recognise("git push -u origin feat/x", "")[0]).toEqual({ kind: "push", branch: "feat/x" });
  expect(recognise("git push --set-upstream origin feat/y", "")[0]).toEqual({ kind: "push", branch: "feat/y" });
});
test("gh pr create takes the url from output", () => {
  const r = recognise("gh pr create --draft --title x", "Creating pull request\nhttps://github.com/o/r/pull/12\n");
  expect(r[0]).toEqual({ kind: "pr", prUrl: "https://github.com/o/r/pull/12" });
});
test("compound commands yield several records", () => {
  const r = recognise("git push -u origin a && gh pr create --fill", "https://github.com/o/r/pull/4");
  expect(r.map((x) => x.kind)).toEqual(["push", "pr"]);
});
test("unrelated commands yield nothing", () => {
  expect(recognise("git status", "")).toEqual([]);
});
test("a leading rtk token is ignored", () => {
  expect(recognise("rtk git push -u origin feat/x", "")).toEqual([{ kind: "push", branch: "feat/x" }]);
  expect(recognise("rtk gh pr create", "https://github.com/o/r/pull/3")).toEqual([{ kind: "pr", prUrl: "https://github.com/o/r/pull/3" }]);
});
