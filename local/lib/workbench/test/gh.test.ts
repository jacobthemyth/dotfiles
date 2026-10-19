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

test("a stub keyed by slug then branch keeps two repos apart", () => {
  const f = join(mkdtempSync(join(tmpdir(), "wb-gh-")), "stub.json");
  const pr = (n: number) => ({ number: n, url: "u", draft: false, state: "MERGED" });
  writeFileSync(f, JSON.stringify({ prsForBranches: {
    "o/one": { a: { pr: pr(1), base: "main", headRefOid: "one" } },
    "o/two": { a: { pr: pr(2), base: "main", headRefOid: "two" } },
  } }));
  process.env.WORKBENCH_GH_STUB = f;
  expect(prsForBranches("o/one", ["a"]).get("a")?.pr.number).toBe(1);
  expect(prsForBranches("o/two", ["a"]).get("a")?.pr.number).toBe(2);
  expect(prsForBranches("o/three", ["a"]).size).toBe(0);
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
  expect([...m!.keys()]).toEqual(["x/y"]);
  expect(m!.get("x/y")).toEqual({ pr: { number: 7, url: "u", draft: false, state: "OPEN" }, base: "main", headRefOid: "sha" });
  expect(parseBranchResponse(["a"], null)).toBeNull();
});

test("lastGhError set on failure and cleared on success", () => {
  expect(prsForBranches("o/r", ["a"], { run: () => null }).size).toBe(0);
  expect(gh.lastGhError).not.toBeNull();
  prsForBranches("o/r", ["a"], { run: () => ({ data: { repository: {} } }) });
  expect(gh.lastGhError).toBeNull();
});

test("batching maps nodes to the right branch past index 49", () => {
  const branches = Array.from({ length: 120 }, (_, i) => `br${i}`);
  const chosen = ["br10", "br60", "br110"];
  const run = (q: string) => {
    const repository: Record<string, unknown> = {};
    for (const m of q.matchAll(/\b(b\d+): pullRequests\(headRefName: "([^"]*)"/g)) {
      if (chosen.includes(m[2])) {
        const n = Number(m[2].slice(2));
        repository[m[1]] = { nodes: [{ number: n, url: `u${n}`, isDraft: false, state: "OPEN", baseRefName: "main", headRefOid: `sha${n}` }] };
      }
    }
    return { data: { repository } };
  };
  const m = prsForBranches("o/r", branches, { run });
  expect([...m.keys()].sort()).toEqual([...chosen].sort());
  expect(m.get("br60")?.pr.number).toBe(60);
  expect(m.get("br60")?.headRefOid).toBe("sha60");
  expect(m.get("br110")?.pr.number).toBe(110);
  expect(m.get("br110")?.headRefOid).toBe("sha110");
  expect(m.has("br59")).toBe(false);
  expect(m.has("br61")).toBe(false);
});

test("GraphQL error response without repository is a failure", () => {
  const run = () => ({ errors: [{ message: "Could not resolve to a Repository" }], data: null });
  expect(prsForBranches("o/r", ["a"], { run }).size).toBe(0);
  expect(gh.lastGhError).toContain("Could not resolve to a Repository");
});
