import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_MESSAGE, guard } from "../src/cmd/edit-guard";
import { writeJson } from "../src/store";

const saved = process.env.WORKBENCH_STATE_DIR;
let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-guard-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (saved === undefined) delete process.env.WORKBENCH_STATE_DIR; else process.env.WORKBENCH_STATE_DIR = saved;
});

test("guard refuses without a review and execs the real editor with one", () => {
  const calls: string[][] = [], out: string[] = [];
  let paused = 0;
  const deps = { exec: (a: string[]) => { calls.push(a); return 0; }, pause: () => { paused++; }, print: (s: string) => { out.push(s); } };
  expect(guard("ws1", "nvim -u NONE", ["+3", "f.txt"], deps)).toBe(0);
  expect(calls).toEqual([]);
  expect(paused).toBe(1);
  expect(out).toEqual([GUARD_MESSAGE]);
  expect(GUARD_MESSAGE).toBe("lock first: press r in the sidebar");
  writeJson(join(tmp, "state", "reviews", "ws1.json"), { id: "r", workset: "ws1", opened: "t", snapshot: {}, locked: [] });
  expect(guard("ws1", "nvim -u NONE", ["+3", "f.txt"], deps)).toBe(0);
  expect(calls).toEqual([["nvim", "-u", "NONE", "+3", "f.txt"]]);
});

test("guard passes the editor's exit code through", () => {
  writeJson(join(tmp, "state", "reviews", "ws1.json"), { id: "r", workset: "ws1", opened: "t", snapshot: {}, locked: [] });
  expect(guard("ws1", "nvim", ["f"], { exec: () => 3, pause: () => {}, print: () => {} })).toBe(3);
});
