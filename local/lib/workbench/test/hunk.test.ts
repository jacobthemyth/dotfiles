import { test, expect, beforeEach, afterEach } from "bun:test";
import { addAgentComment, commentIdOf, rmComment } from "../src/hunk";
import { drainRecorded } from "../src/spawn";

const saved = process.env.WORKBENCH_DRY_RUN;
beforeEach(() => { process.env.WORKBENCH_DRY_RUN = "1"; drainRecorded(); });
afterEach(() => { if (saved === undefined) delete process.env.WORKBENCH_DRY_RUN; else process.env.WORKBENCH_DRY_RUN = saved; });

test("commentIdOf reads result.commentId from hunk 0.24's comment add output", () => {
  expect(commentIdOf(JSON.stringify({ result: { commentId: "mcp:abc", filePath: "f.txt", line: 2 } }))).toBe("mcp:abc");
  expect(commentIdOf("not json")).toBeNull();
  expect(commentIdOf(JSON.stringify({ result: {} }))).toBeNull();
});

test("addAgentComment returns an id in a dry run and null when hunk refuses", () => {
  const a = addAgentComment({ id: "s", path: "" }, { file: "f", newLine: 1, summary: "x" });
  const b = addAgentComment({ id: "s", path: "" }, { file: "f", newLine: 1, summary: "y" });
  expect(a).toMatch(/^dry:\d+$/);
  expect(b).not.toBe(a);
  process.env.WORKBENCH_DRY_RUN_FAIL = "hunk session comment add";
  try { expect(addAgentComment({ id: "s", path: "" }, { file: "f", newLine: 1, summary: "z" })).toBeNull(); }
  finally { delete process.env.WORKBENCH_DRY_RUN_FAIL; }
});

test("rmComment records the remove command", () => {
  expect(rmComment({ id: "s", path: "" }, "mcp:9")).toBe(true);
  expect(drainRecorded()).toContain("hunk session comment rm s mcp:9 --json");
});
