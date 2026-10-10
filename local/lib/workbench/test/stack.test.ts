import { test, expect } from "bun:test";
import { baseSource, diffBase, orderMembers, stackNodes } from "../src/stack";
import type { Config } from "../src/config";
import type { Member } from "../src/workset";

const config: Config = { repo_roots: [], worktree_dirs: [], exclude_repos: [], github_user: "@me", harnesses: ["claude"], default_branch: "main" };
const mk = (branch: string, over: Partial<Member> = {}): Member => ({
  id: `r#${branch}`, repo: "/r", slug: null, branch, worktree: null, base: null, base_source: null, pr: null,
  order: null, role: "work", added_by: "hand", added_at: "t", ...over,
});

test("diff base prefers pr base, then declared base, then default branch", () => {
  const pr = mk("a", { base: "release", base_source: "pr" });
  const declared = mk("b", { base: "dev", base_source: "declared" });
  const none = mk("c");
  expect(diffBase(pr, config)).toBe("release");
  expect(baseSource(pr)).toBe("pr");
  expect(diffBase(declared, config)).toBe("dev");
  expect(baseSource(declared)).toBe("declared");
  expect(diffBase(none, config)).toBe("main");
  expect(baseSource(none)).toBe("default");
  expect(baseSource(mk("d", { base: "x" }))).toBe("declared");
});

test("base chain orders a stack bottom-up", () => {
  const a = mk("a", { base: "main" }), b = mk("b", { base: "a" }), c = mk("c", { base: "b" });
  expect(orderMembers([c, a, b]).map((m) => m.branch)).toEqual(["a", "b", "c"]);
});

test("explicit order wins over the chain", () => {
  const a = mk("a"), b = mk("b", { base: "a" }), z = mk("z", { order: 1 }), y = mk("y", { order: 0 });
  expect(orderMembers([a, b, z, y]).map((m) => m.branch)).toEqual(["y", "z", "a", "b"]);
});

test("ties break by branch name and repos stay grouped", () => {
  const out = orderMembers([mk("b"), mk("x", { repo: "/s" }), mk("a"), mk("c", { repo: "/s" })]);
  expect(out.map((m) => m.branch)).toEqual(["a", "b", "c", "x"]);
  expect(out.map((m) => m.repo)).toEqual(["/r", "/r", "/s", "/s"]);
});

test("a cycle in the chain terminates", () => {
  const a = mk("a", { base: "b" }), b = mk("b", { base: "a" });
  expect(orderMembers([a, b])).toHaveLength(2);
});

test("whole-stack node spans bottom base to top member", () => {
  const a = mk("a", { base: "main" }), b = mk("b", { base: "a" }), c = mk("c", { base: "b" });
  const nodes = stackNodes([c, a, b], config);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({ repo: "/r", slug: null, bottomBase: "main" });
  expect(nodes[0].top.branch).toBe("c");
});

test("unrelated members or a single member yield no node", () => {
  expect(stackNodes([mk("a"), mk("b")], config)).toEqual([]);
  expect(stackNodes([mk("a", { base: "main" })], config)).toEqual([]);
});
