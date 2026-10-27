import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawNote } from "../src/hunk";
import { applyDeletions, recordProxy, syncMember } from "../src/notes";
import { loadNotes, saveNotes } from "../src/review";
import { drainRecorded } from "../src/spawn";
import { loadWindow, newWindow, saveWindow, setHunkSession, type Window } from "../src/window";
import type { Member } from "../src/workset";

const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN", "WORKBENCH_DRY_RUN_FAIL", "WORKBENCH_DRY_RUN_HUNK_NOTES"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let tmp: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-notes-")));
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

const M = "/r#feat";
const member = { id: M, repo: "/r", branch: "feat", worktree: "/r" } as Member;
const note = (noteId: string, over: Partial<RawNote> = {}): RawNote => ({ noteId, source: "user", filePath: "f.txt", newRange: [1, 1], body: noteId, ...over });
const onScreen = (...notes: RawNote[]) => { process.env.WORKBENCH_DRY_RUN_HUNK_NOTES = JSON.stringify({ comments: notes }); };
const win = (over: Partial<Window> = {}): Window => ({ ...newWindow("ws1"), hunkSessionId: "a", hunkPaneCwd: "/r", current: M, ...over });

test("applyDeletions drops a note that was live and is gone, and a deleted proxy's original", () => {
  const r = applyDeletions([note("user:1"), note("user:2"), note("user:3")], { "user:1": null, "mcp:p2": "user:2", "user:3": null }, new Set(["user:3", "mcp:other"]));
  expect(r.notes.map((n) => n.noteId)).toEqual(["user:3"]);
  expect(r.deleted.sort()).toEqual(["user:1", "user:2"]);
});

test("applyDeletions with an empty live set deletes nothing", () => {
  const r = applyDeletions([note("user:1")], {}, new Set());
  expect(r.notes.map((n) => n.noteId)).toEqual(["user:1"]);
  expect(r.deleted).toEqual([]);
});

test("a note deleted in hunk leaves the snapshot at the next sync", () => {
  const w = win(); saveWindow(w);
  onScreen(note("user:1"), note("user:2"));
  syncMember(w, member);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:1", "user:2"]);
  onScreen(note("user:2"));
  const r = syncMember(w, member);
  expect(r.deleted).toEqual(["user:1"]);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:2"]);
  expect(loadWindow("ws1")!.live[M]).toEqual({ "user:2": null });
});

test("syncMember after a hunk session change deletes nothing and rebuilds live from what is on screen", () => {
  const w = win({ live: { [M]: { "user:1": null } } }); saveWindow(w);
  saveNotes("ws1", M, [note("user:1")]);
  setHunkSession(w, "b"); saveWindow(w); // callers save the window after a restart
  onScreen();
  syncMember(w, member);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:1"]);
  expect(loadWindow("ws1")!.live[M]).toEqual({});
});

test("syncMember keeps a proxy still on screen and returns threaded user replies", () => {
  const w = win(); saveWindow(w);
  saveNotes("ws1", M, [note("user:1")]);
  recordProxy(w, M, "mcp:p", "user:1");
  onScreen(note("mcp:p", { source: "agent", author: "you" }), note("user:9", { parentId: "mcp:p", body: "/resolve" }));
  const r = syncMember(w, member);
  expect(loadWindow("ws1")!.live[M]).toEqual({ "mcp:p": "user:1" });
  expect(r.replies).toEqual([{ id: "user:9", parentId: "mcp:p", body: "/resolve" }]);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:1"]);
});

test("a deleted proxy removes its original from the snapshot", () => {
  const w = win(); saveWindow(w);
  saveNotes("ws1", M, [note("user:1")]);
  recordProxy(w, M, "mcp:p", "user:1");
  onScreen();
  expect(syncMember(w, member).deleted).toEqual(["user:1"]);
  expect(loadNotes("ws1", M)).toEqual([]);
});

test("a failed hunk listing deletes nothing", () => {
  const w = win({ live: { [M]: { "user:1": null } } }); saveWindow(w);
  saveNotes("ws1", M, [note("user:1")]);
  process.env.WORKBENCH_DRY_RUN_FAIL = "hunk session comment list";
  const r = syncMember(w, member);
  expect(r.deleted).toEqual([]);
  expect(loadNotes("ws1", M).map((n) => n.noteId)).toEqual(["user:1"]);
  expect(loadWindow("ws1")!.live[M]).toEqual({ "user:1": null });
});
