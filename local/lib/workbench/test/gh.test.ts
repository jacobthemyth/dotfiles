import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gh from "../src/gh";
import { prsForBranches, buildBranchQuery, parseBranchResponse, BATCH } from "../src/gh";

beforeEach(() => { delete process.env.WORKBENCH_GH_STUB; });
afterEach(() => { delete process.env.WORKBENCH_GH_STUB; });

test("prsForBranches returns the stub's map", () => {
  const f = join(mkdtempSync(join(tmpdir(), "wb-gh-")), "stub.json");
  const pr = { number: 7, url: "u", draft: false, state: "MERGED" };
  writeFileSync(f, JSON.stringify({ prsForBranches: { a: { pr, base: "main", headRefOid: "abc" } } }));
  process.env.WORKBENCH_GH_STUB = f;
  const m = prsForBranches("o/r", ["a", "b"]);
  expect(m.get("a")?.pr.state).toBe("MERGED");
  expect(m.get("a")?.headRefOid).toBe("abc");
  expect(m.has("b")).toBe(false);
});

test("buildQuery aliases by index and escapes names", () => {
  const q = buildBranchQuery("o", "r", ['we"ird/na.me', "x\\y"]);
  expect(q).toContain('b0: pullRequests(headRefName: "we\\"ird/na.me"');
  expect(q).toContain('b1: pullRequests(headRefName: "x\\\\y"');
  expect(q).toContain("last: 1");
  expect(q).toContain("headRefOid");
  expect(q).not.toMatch(/we"ird\/na\.me:/);
});

test("batches of 50", () => {
  const branches = Array.from({ length: 120 }, (_, i) => `br${i}`);
  const counts: number[] = [];
  const run = (q: string) => { counts.push((q.match(/\bb\d+: pullRequests/g) ?? []).length); return { data: { repository: {} } }; };
  expect(BATCH).toBe(50);
  prsForBranches("o/r", branches, { run });
  expect(counts).toEqual([50, 50, 20]);
});

test("parseBranchResponse maps aliases back", () => {
  const json = { data: { repository: {
    b0: { nodes: [{ number: 7, url: "u", isDraft: false, state: "OPEN", baseRefName: "main", headRefOid: "sha" }] },
    b1: { nodes: [] },
  } } };
  const m = parseBranchResponse(["x/y", "z", "missing"], json);
  expect([...m.keys()]).toEqual(["x/y"]);
  expect(m.get("x/y")).toEqual({ pr: { number: 7, url: "u", draft: false, state: "OPEN" }, base: "main", headRefOid: "sha" });
  expect(parseBranchResponse(["a"], null).size).toBe(0);
});

test("lastGhError set on failure and cleared on success", () => {
  expect(prsForBranches("o/r", ["a"], { run: () => null }).size).toBe(0);
  expect(gh.lastGhError).not.toBeNull();
  prsForBranches("o/r", ["a"], { run: () => ({ data: { repository: {} } }) });
  expect(gh.lastGhError).toBeNull();
});
