import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as inbox from "../src/inbox";
import { renderMarkdown } from "../src/render";
import { inboxFile, type ReviewFile } from "../src/submit";
import { writeJson } from "../src/store";
import { sub } from "../src/paths";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wb-inbox-")); process.env.WORKBENCH_STATE_DIR = dir; });
afterEach(() => { delete process.env.WORKBENCH_STATE_DIR; rmSync(dir, { recursive: true, force: true }); });

const review = (id: string, over: Partial<ReviewFile> = {}): ReviewFile => ({
  id, workset: "ws", submitted: "2026-10-10T10:00:00.000Z", message: null,
  comments: [], edits: [], failed: [], sessions: ["claude-a"], ...over,
});
const put = (key: string, r: ReviewFile, read = false) => writeJson(inboxFile(key, r.id), { ...r, read });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("render markdown groups comments by member and path with type badges and sha", () => {
  const c = (id: string, member: string, branch: string, type: "change" | "question" | "note", path: string, text: string, replies: any[] = []) => ({
    id, member, repo: "/r", slug: member.split("#")[0], branch, path, line: { side: "new" as const, start: 12, end: 14 },
    sha: "abcdef1234567", type, text, replies,
  });
  const md = renderMarkdown(review("rv1", {
    message: "Please tidy",
    comments: [
      c("user:1", "o/a", "feat-a", "change", "src/x.ts", "rename this", [{ at: "2026-10-10T11:00:00.000Z", by: "agent", text: "done" }]),
      c("user:2", "o/b", "feat-b", "question", "src/y.ts", "why?"),
    ],
    edits: [{ repo: "/r", branch: "feat-a", sha: "1234567890abc", files: ["src/x.ts"] }],
    failed: [{ repo: "/r", branch: "feat-b", files: ["src/y.ts"], error: "hook rejected" }],
  }));
  expect(md).toContain("rv1");
  expect(md).toContain("Please tidy");
  expect(md).toContain("### o/a#feat-a @ abcdef1");
  expect(md).toContain("### o/b#feat-b @ abcdef1");
  expect(md).toContain("- **change** `src/x.ts:12-14` (id `user:1`) — rename this");
  expect(md).toContain("- **question** `src/y.ts:12-14` (id `user:2`) — why?");
  expect(md).toMatch(/\n {2,}.*agent.*done/);
  expect(md).toContain("## Your edits were committed");
  expect(md).toContain("1234567");
  expect(md).toContain("## Failed edits");
  expect(md).toContain("hook rejected");
});

test("wait returns when a review file appears", async () => {
  setTimeout(() => put("claude-a", review("rv1")), 150);
  const got = await inbox.wait("claude-a", 5000, 50);
  expect(got?.id).toBe("rv1");
  expect(existsSync(join(sub("watch"), "claude-a.pid"))).toBe(false);
});

test("wait returns null on timeout and ignores read reviews", async () => {
  put("claude-a", review("old"), true);
  expect(await inbox.wait("claude-a", 200, 50)).toBeNull();
});

test("show marks the review read; list shows unread first", () => {
  put("claude-a", review("r-old", { submitted: "2026-10-09T00:00:00.000Z" }));
  put("claude-a", review("r-new", { submitted: "2026-10-10T00:00:00.000Z" }), true);
  put("claude-a", review("r-newer", { submitted: "2026-10-10T05:00:00.000Z" }), true);
  expect(inbox.list("claude-a").map((r) => r.id)).toEqual(["r-old", "r-newer", "r-new"]);
  expect(inbox.unreadCount("claude-a")).toBe(1);
  inbox.markRead("claude-a", "r-old");
  expect(inbox.unreadCount("claude-a")).toBe(0);
  expect(inbox.get("claude-a", "r-old")?.id).toBe("r-old");
  expect(JSON.parse(readFileSync(inboxFile("claude-a", "r-old"), "utf8")).read).toBe(true);
});

test("a second watcher replaces the first via the pid file", async () => {
  mkdirSync(sub("watch"), { recursive: true });
  const pidFile = join(sub("watch"), "claude-a.pid");
  writeFileSync(pidFile, "999999");
  // dead pid: replaced, no throw
  expect(await inbox.wait("claude-a", 100, 30)).toBeNull();
  // another live pid takes over mid-wait: this watcher gives up
  const p = inbox.wait("claude-a", 5000, 30);
  await sleep(100);
  const other = Bun.spawn(["sleep", "30"]);
  try {
    writeFileSync(pidFile, String(other.pid));
    expect(await p).toBeNull();
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(other.pid));
  } finally { other.kill(); }
});

test("wait kills a live previous watcher", async () => {
  const old = Bun.spawn(["sleep", "30"]);
  mkdirSync(sub("watch"), { recursive: true });
  writeFileSync(join(sub("watch"), "claude-a.pid"), String(old.pid));
  await inbox.wait("claude-a", 100, 30);
  await Promise.race([old.exited, sleep(2000)]);
  expect(old.killed || old.exitCode !== null || old.signalCode !== null).toBe(true);
});

test("handle turnEnded returns an empty outcome", async () => {
  const { handle } = await import("../src/hook");
  expect(handle({ kind: "turnEnded", harness: "claude", session: "x" })).toEqual({});
});
