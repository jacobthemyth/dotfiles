import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Comment } from "../src/comments";
import { run as replyCli } from "../src/cmd/reply";
import type { RawNote } from "../src/hunk";
import { syncMember } from "../src/notes";
import { addReply, recordThread, rehydrateReplies } from "../src/reply";
import { drainResolved, pendingFile } from "../src/resolve";
import { archiveFile, loadNotes, saveNotes } from "../src/review";
import { drainRecorded } from "../src/spawn";
import { readJson, writeJson } from "../src/store";
import { inboxFile, type ReviewFile } from "../src/submit";
import { loadWindow, newWindow, saveWindow, type Window } from "../src/window";
import type { Member } from "../src/workset";

const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN", "WORKBENCH_DRY_RUN_FAIL", "WORKBENCH_DRY_RUN_HUNK_NOTES",
  "WORKBENCH_DRY_RUN_HUNK_SESSIONS", "WORKBENCH_SESSION", "CLAUDE_CODE_SESSION_ID"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let tmp: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-resolve-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_DRY_RUN = "1";
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
  drainRecorded();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const KEY = "claude-a", M = "/r#feat", SID = "sid-1";
const member = { id: M, repo: "/r", branch: "feat", worktree: "/r" } as Member;
const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id, member: M, repo: "/r", slug: null, branch: "feat", path: "src/x.ts", line: { side: "new", start: 12, end: 14 },
  sha: "abc", type: "question", text: "why this?", replies: [{ at: "t", by: KEY, text: "because" }], ...over,
});
const reviewFile = (id: string, comments: Comment[]): ReviewFile => ({
  id, workset: "ws1", submitted: "2026-10-10T10:00:00.000Z", message: null, comments, edits: [], failed: [], sessions: [KEY], resolved: [],
});
const deliver = (f: ReviewFile) => { writeJson(inboxFile(KEY, f.id), { ...f, read: true }); writeJson(archiveFile("ws1", f.id), f); };
const archive = (id: string) => readJson<ReviewFile>(archiveFile("ws1", id))!;
const inbox = (id: string) => readJson<ReviewFile>(inboxFile(KEY, id))!;
const note = (noteId: string, over: Partial<RawNote> = {}): RawNote => ({ noteId, source: "user", filePath: "src/x.ts", newRange: [12, 12], body: noteId, ...over });
const agent = (noteId: string, parentId?: string) => note(noteId, { source: "agent", author: KEY, ...(parentId ? { parentId } : {}) });
const threaded = (noteId: string, parentId: string, body: string) => note(noteId, { parentId, body });
const onScreen = (...notes: RawNote[]) => { process.env.WORKBENCH_DRY_RUN_HUNK_NOTES = JSON.stringify({ comments: notes }); };
const liveSession = () => { process.env.WORKBENCH_DRY_RUN_HUNK_SESSIONS = JSON.stringify({ sessions: [{ sessionId: SID, terminal: { locations: [{ source: "tmux", paneId: "%1" }] } }] }); };
const win = (over: Partial<Window> = {}): Window => ({ ...newWindow("ws1"), hunkPaneId: "%1", hunkSessionId: SID, hunkPaneCwd: "/r", current: M, ...over });
const rms = () => drainRecorded().filter((c) => c.startsWith("hunk session comment rm"));

test("/resolve under a shown reply resolves the comment in archive and inbox, queues it and clears the thread child-first", () => {
  deliver(reviewFile("r1", [comment("user:1")]));
  const w = win({ threads: { "mcp:7": "user:1" } }); saveWindow(w);
  onScreen(agent("mcp:7"), threaded("user:9", "mcp:7", "/resolve fine"));
  drainRecorded();
  const r = syncMember(w, member);
  expect(archive("r1").comments[0].resolved).toMatchObject({ by: "you", text: "fine" });
  expect(inbox("r1").comments[0].resolved).toMatchObject({ by: "you", text: "fine" });
  expect(inbox("r1") as unknown as { read: boolean }).toMatchObject({ read: true });
  expect(readJson(pendingFile("ws1"))).toEqual(["user:1"]);
  expect(rms()).toEqual(["hunk session comment rm sid-1 user:9 --json", "hunk session comment rm sid-1 mcp:7 --json"]);
  expect(loadWindow("ws1")!.threads).toEqual({});
  expect(r.warnings).toEqual([]);
});

test("/resolve under the original note still on screen after submit resolves it and removes replies before the note", () => {
  deliver(reviewFile("r1", [comment("user:1")]));
  const w = win({ threads: { "mcp:7": "user:1" } }); saveWindow(w);
  onScreen(note("user:1"), agent("mcp:7", "user:1"), threaded("user:9", "user:1", "/resolve"));
  drainRecorded();
  syncMember(w, member);
  expect(archive("r1").comments[0].resolved).toMatchObject({ text: "" });
  expect(rms()).toEqual([
    "hunk session comment rm sid-1 user:9 --json", "hunk session comment rm sid-1 mcp:7 --json", "hunk session comment rm sid-1 user:1 --json",
  ]);
});

test("a delivered note still on screen is not snapshotted again", () => {
  deliver(reviewFile("r1", [comment("user:1")]));
  const w = win(); saveWindow(w);
  onScreen(note("user:1"), note("user:2"));
  syncMember(w, member);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:2"]);
});

test("/resolve under an unknown parent warns and removes nothing", () => {
  const w = win(); saveWindow(w);
  onScreen(agent("mcp:x"), threaded("user:9", "mcp:x", "/resolve"));
  drainRecorded();
  const r = syncMember(w, member);
  expect(r.warnings).toEqual(["cannot resolve: unknown thread"]);
  expect(rms()).toEqual([]);
  expect(existsSync(pendingFile("ws1"))).toBe(false);
});

test("/resolve under an own un-submitted note drops it like a delete", () => {
  const w = win(); saveWindow(w);
  onScreen(note("user:5"), threaded("user:9", "user:5", "/resolve"));
  drainRecorded();
  syncMember(w, member);
  expect(loadNotes("ws1", M)).toEqual([]);
  expect(rms()).toEqual(["hunk session comment rm sid-1 user:9 --json", "hunk session comment rm sid-1 user:5 --json"]);
  expect(loadWindow("ws1")!.live[M]).toEqual({});
});

test("/resolve under a proxy of an own note drops the original", () => {
  saveNotes("ws1", M, [note("user:5")]);
  const w = win({ live: { [M]: { "mcp:p": "user:5" } } }); saveWindow(w);
  onScreen(agent("mcp:p"), threaded("user:9", "mcp:p", "/resolve"));
  drainRecorded();
  syncMember(w, member);
  expect(loadNotes("ws1", M)).toEqual([]);
  expect(rms()).toEqual(["hunk session comment rm sid-1 user:9 --json", "hunk session comment rm sid-1 mcp:p --json"]);
});

test("a threaded reply that is not /resolve is left alone", () => {
  deliver(reviewFile("r1", [comment("user:1")]));
  const w = win({ threads: { "mcp:7": "user:1" } }); saveWindow(w);
  onScreen(agent("mcp:7"), threaded("user:9", "mcp:7", "ok but rename it"));
  drainRecorded();
  syncMember(w, member);
  expect(archive("r1").comments[0].resolved).toBeUndefined();
  expect(rms()).toEqual([]);
});

test("rehydrateReplies skips a resolved comment and records the thread for a shown one", () => {
  deliver(reviewFile("r1", [comment("user:1", { resolved: { at: "t", by: "you", text: "" } }), comment("user:2")]));
  const w = win(); saveWindow(w);
  onScreen();
  drainRecorded();
  rehydrateReplies(w, member);
  const adds = drainRecorded().filter((c) => c.startsWith("hunk session comment add"));
  expect(adds).toHaveLength(1);
  expect(adds[0]).toContain("re: why this?");
  const threads = loadWindow("ws1")!.threads;
  expect(Object.values(threads)).toEqual(["user:2"]);
});

test("addReply to a resolved comment appends, does not show, and the CLI says (thread resolved)", async () => {
  deliver(reviewFile("r1", [comment("user:1", { resolved: { at: "t", by: "you", text: "" } })]));
  saveWindow(win()); liveSession(); onScreen();
  drainRecorded();
  const r = addReply(KEY, "r1", "user:1", "late");
  expect(r).toMatchObject({ shown: false, resolved: true });
  expect(drainRecorded().filter((c) => c.startsWith("hunk session comment add"))).toEqual([]);
  expect(archive("r1").comments[0].replies.map((x) => x.text)).toEqual(["because", "late"]);
  const out: string[] = [], log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try { expect(await replyCli(["--review", "r1", "--comment", "user:1", "--text", "later", "--session", KEY])).toBe(0); }
  finally { console.log = log; }
  expect(out.join("\n")).toContain("(thread resolved)");
});

test("addReply shown live records the thread", () => {
  deliver(reviewFile("r1", [comment("user:1", { replies: [] })]));
  saveWindow(win()); liveSession(); onScreen();
  expect(addReply(KEY, "r1", "user:1", "now").shown).toBe(true);
  expect(Object.values(loadWindow("ws1")!.threads)).toEqual(["user:1"]);
});

test("drainResolved returns the ids once and removes the file", () => {
  writeJson(pendingFile("ws1"), ["user:1", "user:2"]);
  expect(drainResolved("ws1")).toEqual(["user:1", "user:2"]);
  expect(drainResolved("ws1")).toEqual([]);
  expect(existsSync(pendingFile("ws1"))).toBe(false);
});

test("final #1: a delivered note already in the snapshot (a tick racing a shell submit) is dropped, not kept", () => {
  deliver(reviewFile("r1", [comment("user:1")]));
  saveNotes("ws1", M, [note("user:1"), note("user:2")]); // the tick read these before submit cleared the directory
  const w = win({ live: { [M]: { "user:1": null, "user:2": null } } }); saveWindow(w);
  onScreen(note("user:1"), note("user:2"));
  syncMember(w, member);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:2"]);
});

test("final #2: a thread the agent records while the sidebar holds the window survives saves and resolutions", () => {
  deliver(reviewFile("r1", [comment("user:1"), comment("user:2")]));
  const w = win({ threads: { "mcp:7": "user:1" } }); saveWindow(w);
  recordThread("ws1", SID, "mcp:8", "user:2"); // the agent's process, after the sidebar loaded w
  onScreen(agent("mcp:7"), agent("mcp:8"), threaded("user:9", "mcp:7", "/resolve"));
  syncMember(w, member);
  expect(loadWindow("ws1")!.threads).toEqual({ "mcp:8": "user:2" });
  const held = loadWindow("ws1")!;
  recordThread("ws1", SID, "mcp:10", "user:2");
  saveWindow(held); // repoint and ensureWindow save the object they hold
  expect(loadWindow("ws1")!.threads).toEqual({ "mcp:8": "user:2", "mcp:10": "user:2" });
});
