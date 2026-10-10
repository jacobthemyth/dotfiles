import { test, expect } from "bun:test";
import type { Config } from "../src/config";
import type { Found } from "../src/derive";
import type { Pointer } from "../src/session";
import { buildRows, clamp, move, scroll } from "../src/sidebar-model";
import { addMember, type Workset } from "../src/workset";

const cfg = { default_branch: "main" } as Config;
function ws(): Workset {
  const w: Workset = { name: "w", created: "", members: [], sessions: [], ignored: [] };
  addMember(w, { repo: "/r", slug: "o/r", branch: "a", worktree: "/wa", added_by: "t", pr: { number: 3, url: "", draft: true, state: "OPEN" } });
  addMember(w, { repo: "/r", slug: "o/r", branch: "b", base: "a", worktree: "/wb", added_by: "t", pr: { number: 4, url: "", draft: false, state: "MERGED" } });
  addMember(w, { repo: "/r", slug: "o/r", branch: "junk", worktree: "/wj", role: "throwaway", added_by: "t" });
  return w;
}
const found: Found = { repo: "/s", slug: "o/s", branch: "x", worktree: "/wx", pr: null, base: null, main: false };
const ptr = (key: string, closed: string | null): Pointer => ({ key, harness: "claude", session: key, workset: "w", cwd: "/", opened: "", closed });

test("rows: ordered work members, a whole-stack row, unclaimed and sessions; throwaways hidden", () => {
  const rows = buildRows(ws(), cfg, { showThrowaway: false, unclaimed: [found], sessions: [ptr("claude-1", null), ptr("claude-2", "t")], current: "o/r#b" });
  expect(rows.map((r) => r.text)).toEqual([
    "members",
    " [work] o/r#a  PR #3 draft  (main → a)",
    "*[work] o/r#b  PR #4 merged  (a → b)",
    "*whole stack o/r  (main → b)",
    "unclaimed (1)",
    "  o/s#x  -",
    "sessions",
    "  claude-1  open",
    "  claude-2  closed",
  ]);
});

test("rows: t shows throwaways; unclaimed shows scanning before derive returns", () => {
  const rows = buildRows(ws(), cfg, { showThrowaway: true, unclaimed: null, sessions: [], current: null });
  expect(rows.some((r) => r.text.includes("[throwaway] o/r#junk"))).toBe(true);
  expect(rows.some((r) => r.text === "unclaimed (scanning…)")).toBe(true);
});

test("selection skips headers and sessions and wraps at both ends", () => {
  const rows = buildRows(ws(), cfg, { showThrowaway: false, unclaimed: [found], sessions: [ptr("claude-1", null)], current: null });
  const first = clamp(rows, 0);
  expect(first).toBe(1);
  expect(move(rows, first, 1)).toBe(2);
  expect(move(rows, 3, 1)).toBe(5); // stack row -> unclaimed item, skipping the header
  expect(move(rows, 5, 1)).toBe(1); // wraps past sessions to the top
  expect(move(rows, first, -1)).toBe(5);
  expect(move([{ kind: "header", text: "x" }], 0, 1)).toBe(-1);
});

test("scroll keeps the selection inside the window", () => {
  expect(scroll(0, 3, 5)).toBe(0);
  expect(scroll(0, 7, 5)).toBe(3);
  expect(scroll(4, 2, 5)).toBe(2);
  expect(scroll(4, -1, 5)).toBe(0);
});
