import { test, expect } from "bun:test";
import type { Config } from "../src/config";
import type { Pointer } from "../src/session";
import { buildRows, clamp, headerLine, KEYS, move, scroll, sessionLine, splitKeys, STATUS, type SessionView } from "../src/sidebar-model";
import { addMember, type Workset } from "../src/workset";

const cfg = { default_branch: "main" } as Config;
function ws(): Workset {
  const w: Workset = { name: "w", created: "", members: [], sessions: [], ignored: [] };
  addMember(w, { repo: "/r", slug: "o/r", branch: "a", worktree: "/wa", added_by: "t", pr: { number: 3, url: "", draft: true, state: "OPEN" } });
  addMember(w, { repo: "/r", slug: "o/r", branch: "b", base: "a", worktree: "/wb", added_by: "t", pr: { number: 4, url: "", draft: false, state: "MERGED" } });
  addMember(w, { repo: "/r", slug: "o/r", branch: "junk", worktree: "/wj", role: "throwaway", added_by: "t" });
  return w;
}
const ptr = (key: string, closed: string | null): Pointer => ({ key, harness: "claude", session: key, workset: "w", cwd: "/", opened: "", closed });
const reply = { at: "t", by: "claude", text: "ok" };
// One review per entry: read flag and, per comment, its reply count.
const sv = (key: string, closed: string | null, reviews: [boolean, number[]][] = []): SessionView => ({
  pointer: ptr(key, closed),
  reviews: reviews.map(([read, cs]) => ({ read, comments: cs.map((n) => ({ replies: Array(n).fill(reply) })) })),
});

test("rows: ordered work members, a whole-stack row and sessions; throwaways hidden", () => {
  const rows = buildRows(ws(), cfg, { showThrowaway: false, sessions: [sv("claude-1", null, [[false, [1, 0, 2]], [true, [0, 1]]]), sv("claude-2", "t")], current: "o/r#b" });
  expect(rows.map((r) => r.text)).toEqual([
    "members",
    " [work] o/r#a  PR #3 draft  (main → a)",
    "*[work] o/r#b  PR #4 merged  (a → b)",
    "*whole stack o/r  (main → b)",
    "sessions",
    "  claude-1  open  inbox: 1 unread  replies 3/5",
    "  claude-2  closed  inbox: 0 unread  replies 0/0",
  ]);
});

test("rows: t shows throwaways", () => {
  const rows = buildRows(ws(), cfg, { showThrowaway: true, sessions: [], current: null });
  expect(rows.some((r) => r.text.includes("[throwaway] o/r#junk"))).toBe(true);
});

test("selection skips headers and sessions and wraps at both ends", () => {
  const rows = buildRows(ws(), cfg, { showThrowaway: false, sessions: [sv("claude-1", null)], current: null });
  const first = clamp(rows, 0);
  expect(first).toBe(1);
  expect(move(rows, first, 1)).toBe(2);
  expect(move(rows, 3, 1)).toBe(1); // stack row wraps past sessions to the top
  expect(move(rows, first, -1)).toBe(3);
  expect(move([{ kind: "header", text: "x" }], 0, 1)).toBe(-1);
});

test("scroll keeps the selection inside the window", () => {
  expect(scroll(0, 3, 5)).toBe(0);
  expect(scroll(0, 7, 5)).toBe(3);
  expect(scroll(4, 2, 5)).toBe(2);
  expect(scroll(4, -1, 5)).toBe(0);
});

test("session line: unread reviews, comments with at least one reply over all comments", () => {
  expect(sessionLine(sv("claude-abc", null, [[false, [1, 1, 0, 0, 0]]]))).toBe("claude-abc  open  inbox: 1 unread  replies 2/5");
  expect(sessionLine(sv("claude-x", "t", [[false, [0]], [false, []], [true, [3]]]))).toBe("claude-x  closed  inbox: 2 unread  replies 1/2");
  // A comment from an older file without a replies field counts as unanswered.
  expect(sessionLine({ pointer: ptr("k", null), reviews: [{ read: true, comments: [{}] }] })).toBe("k  open  inbox: 0 unread  replies 0/1");
});

test("splitKeys passes plain keys and arrows through", () => {
  expect(splitKeys("jk\r\x1b[A\x1b[B\x1bOC")).toEqual({ keys: ["j", "k", "\r", "\x1b[A", "\x1b[B", "\x1b[C"], rest: "" });
});

test("splitKeys drops terminal replies whole, so their letters never act as keys", () => {
  // OSC palette replies (BEL and ST terminated), a DA1 reply, a focus event, a DCS reply.
  const replies = "\x1b]11;rgb:1c1c/acac/2e2e\x07\x1b]4;1;rgb:cccc/0000/0000\x1b\\\x1b[?62;22c\x1b[I\x1bP>|tmux 3.8\x1b\\";
  expect(splitKeys(`\r${replies}j`)).toEqual({ keys: ["\r", "j"], rest: "" });
});

test("splitKeys holds a reply cut off at the chunk end for the next chunk", () => {
  const first = splitKeys("j\x1b]11;rgb:1c1c/");
  expect(first).toEqual({ keys: ["j"], rest: "\x1b]11;rgb:1c1c/" });
  expect(splitKeys(first.rest + "acac/2e2e\x1b\\k")).toEqual({ keys: ["k"], rest: "" });
  expect(splitKeys("\x1b[?62;").rest).toBe("\x1b[?62;");
});

test("splitKeys drops a lone Esc instead of holding it", () => {
  expect(splitKeys("\x1b")).toEqual({ keys: [], rest: "" });
});

test("header shows the mode", () => {
  expect(headerLine("ws1", null)).toBe("ws1  watching");
  expect(headerLine("ws1", "r-1")).toBe("ws1  reviewing r-1");
});

test("the key line names r and the status copy is fixed", () => {
  expect(KEYS).toBe("j/k move  ⏎ show  t throwaways  r review  s submit  c close (asks for yes)  q quit");
  expect(STATUS).toEqual({ alreadyOpen: "a review is already open", nothingToSubmit: "no review to submit; press r", nothingToClose: "nothing to close" });
});
