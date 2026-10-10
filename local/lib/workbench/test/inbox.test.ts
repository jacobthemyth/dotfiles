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

// A real process whose command line contains "workbench" (the verified-kill path), and one that does not.
const WB_DIR = join(import.meta.dir, "..");
const spawnWorkbench = () => Bun.spawn(["bun", "-e", "setInterval(()=>{},1000)", "workbench-fake"], { cwd: WB_DIR });
const entry = (pid: number, started = Date.now()) => JSON.stringify({ pid, started, token: "t" });
const pidPath = () => join(sub("watch"), "claude-a.pid");
const writePid = (pid: number, started?: number) => { mkdirSync(sub("watch"), { recursive: true }); writeFileSync(pidPath(), entry(pid, started)); };
const settled = (p: { exited: Promise<number> }) => Promise.race([p.exited.then(() => true), sleep(2000).then(() => false)]);

test("a dead pid in the pid file is replaced", async () => {
  writePid(999999);
  expect(await inbox.wait("claude-a", 100, 30)).toBeNull();
});

test("wait kills a verified previous workbench watcher", async () => {
  const old = spawnWorkbench(); await sleep(300);
  writePid(old.pid, Date.now());
  await inbox.wait("claude-a", 100, 30);
  expect(await settled(old)).toBe(true);
});

test("wait does not kill a live non-workbench process named in a stale pid file", async () => {
  const other = Bun.spawn(["sleep", "30"]);
  try {
    writePid(other.pid);
    expect(await inbox.wait("claude-a", 150, 30)).toBeNull();
    expect(await settled(other)).toBe(false);
  } finally { other.kill(); }
});

test("a pid reused after the file was written is not killed", async () => {
  const old = spawnWorkbench(); await sleep(300);
  try {
    writePid(old.pid, Date.now() - 3600_000);
    await inbox.wait("claude-a", 100, 30);
    expect(await settled(old)).toBe(false);
  } finally { old.kill(); }
});

test("a watcher gives up when a newer verified watcher takes the pid file", async () => {
  const p = inbox.wait("claude-a", 5000, 30);
  await sleep(100);
  const other = spawnWorkbench(); await sleep(300);
  try {
    writePid(other.pid, Date.now());
    expect(await p).toBeNull();
  } finally { other.kill(); }
});

test("stopWatcher kills a verified watcher and removes the pid file", async () => {
  const w = spawnWorkbench(); await sleep(300);
  writePid(w.pid, Date.now());
  inbox.stopWatcher("claude-a");
  expect(await settled(w)).toBe(true);
  expect(existsSync(pidPath())).toBe(false);
});

test("stopWatcher leaves a non-workbench process alone but removes the file", async () => {
  const other = Bun.spawn(["sleep", "30"]);
  try {
    writePid(other.pid);
    inbox.stopWatcher("claude-a");
    expect(await settled(other)).toBe(false);
    expect(existsSync(pidPath())).toBe(false);
  } finally { other.kill(); }
});

test("handle turnEnded returns an empty outcome", async () => {
  const { handle } = await import("../src/hook");
  expect(handle({ kind: "turnEnded", harness: "claude", session: "x" })).toEqual({});
});

test("sessionEnded stops that session's watcher", async () => {
  const { handle } = await import("../src/hook");
  const { openPointer } = await import("../src/session");
  openPointer("claude", "a", "/w");
  const w = spawnWorkbench(); await sleep(300);
  writePid(w.pid, Date.now());
  handle({ kind: "sessionEnded", harness: "claude", session: "a" });
  expect(await settled(w)).toBe(true);
  expect(existsSync(pidPath())).toBe(false);
});

test("prompt submitted with unread reviews adds a context line naming the count", async () => {
  const { handle } = await import("../src/hook");
  const prompt = () => handle({ kind: "promptSubmitted", harness: "claude", session: "a", cwd: "/w" });
  expect(prompt()).toEqual({});
  put("claude-a", review("r1"));
  put("claude-a", review("r2"));
  put("claude-a", review("r0"), true);
  expect(prompt().context).toBe("workbench: 2 unread review(s) in your inbox; run `workbench inbox show`.");
});

test("wait exits when its session's pointer is closed", async () => {
  const { openPointer, closePointer } = await import("../src/session");
  openPointer("claude", "a", "/w");
  setTimeout(() => closePointer("claude-a"), 100);
  const t0 = Date.now();
  expect(await inbox.wait("claude-a", 5000, 30)).toBeNull();
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(existsSync(pidPath())).toBe(false);
});

test("stopWatcher logs its decision: stopping a verified watcher, ignoring a stale pid file", async () => {
  const lines: string[] = [];
  const err = console.error; console.error = (s: string) => { lines.push(s); };
  const other = Bun.spawn(["sleep", "30"]);
  try {
    const w = spawnWorkbench(); await sleep(300);
    writePid(w.pid, Date.now());
    inbox.stopWatcher("claude-a");
    expect(await settled(w)).toBe(true);
    writePid(other.pid);
    inbox.stopWatcher("claude-a");
    expect(lines).toEqual([`workbench: stopping watcher ${w.pid}`, "workbench: ignoring stale pid file for claude-a"]);
  } finally { console.error = err; other.kill(); }
});

test("a pointer closed before the watcher started does not stop it (a resume reopens it in parallel)", async () => {
  const { openPointer, closePointer } = await import("../src/session");
  openPointer("claude", "a", "/w");
  closePointer("claude-a");
  await sleep(20);
  setTimeout(() => put("claude-a", review("rv1")), 150);
  expect((await inbox.wait("claude-a", 3000, 30))?.id).toBe("rv1");
});
