import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sub } from "../src/paths";
import { readJson, writeJson } from "../src/store";
import { listPointers, savePointer, type Pointer } from "../src/session";
import { archiveFile } from "../src/review";
import { createWorkset, loadWorkset, saveWorkset } from "../src/workset";
import { renameWorkset } from "../src/rename";

beforeEach(() => { process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-state-")); });

const ptr = (key: string, workset: string): Pointer => ({ key, harness: "claude", session: key, workset, cwd: "/r", opened: "2026-01-01T00:00:00Z", closed: null });
const lockPath = (ws: string) => join(sub("locks"), `${ws}.json`);
const inboxPath = (key: string, id: string) => join(sub("inbox"), key, `${id}.json`);

test("renameWorkset moves the file, pointers, review archives and inbox files", () => {
  const ws = createWorkset("claude-abc");
  ws.sessions = ["claude-1"];
  saveWorkset(ws);
  savePointer(ptr("p1", "claude-abc")); savePointer(ptr("p2", "claude-abc")); savePointer(ptr("p3", "other"));
  writeJson(archiveFile("claude-abc", "x"), { id: "x" });
  writeJson(inboxPath("p1", "r1"), { id: "r1", workset: "claude-abc", read: false });
  writeJson(inboxPath("p1", "r2"), { id: "r2", workset: "other", read: false });
  renameWorkset("claude-abc", "spike");
  expect(loadWorkset("claude-abc")).toBeNull();
  expect(loadWorkset("spike")).toMatchObject({ name: "spike", sessions: ["claude-1"] });
  expect(Object.fromEntries(listPointers().map((p) => [p.key, p.workset]))).toEqual({ p1: "spike", p2: "spike", p3: "other" });
  expect(existsSync(archiveFile("claude-abc", "x"))).toBe(false);
  expect(readJson(archiveFile("spike", "x"))).toEqual({ id: "x" });
  expect(readJson<{ workset: string }>(inboxPath("p1", "r1"))!.workset).toBe("spike");
  expect(readJson<{ workset: string }>(inboxPath("p1", "r2"))!.workset).toBe("other");
});

test("renameWorkset refuses and moves nothing", () => {
  saveWorkset(createWorkset("a")); saveWorkset(createWorkset("b"));
  savePointer(ptr("p1", "a"));
  expect(() => renameWorkset("a", "b")).toThrow('workbench: workset "b" exists');
  expect(() => renameWorkset("a", "Bad Name")).toThrow('workbench: invalid workset name "Bad Name"');
  expect(() => renameWorkset("nope", "c")).toThrow('workbench: no workset "nope"');
  writeJson(archiveFile("a", "x"), { id: "x" });
  writeJson(lockPath("a"), { workset: "a", review: "r", paths: [], opened: "t", holder: "h" });
  expect(() => renameWorkset("a", "c")).toThrow('workbench: "a" has an open review; close or submit it first');
  expect(existsSync(lockPath("a"))).toBe(true);
  expect(loadWorkset("a")!.name).toBe("a");
  expect(loadWorkset("c")).toBeNull();
  expect(listPointers()[0].workset).toBe("a");
  expect(existsSync(archiveFile("a", "x"))).toBe(true);
});

test("renameWorkset refuses a stale reviews destination and moves nothing", () => {
  saveWorkset(createWorkset("a"));
  savePointer(ptr("p1", "a"));
  writeJson(archiveFile("a", "x"), { id: "x" });
  writeJson(archiveFile("c", "x"), { id: "stale" });
  expect(() => renameWorkset("a", "c")).toThrow("workbench: reviews/c already exists; remove or rename it first");
  expect(loadWorkset("a")!.name).toBe("a");
  expect(loadWorkset("c")).toBeNull();
  expect(listPointers()[0].workset).toBe("a");
  expect(readJson(archiveFile("a", "x"))).toEqual({ id: "x" });
  expect(readJson(archiveFile("c", "x"))).toEqual({ id: "stale" });
});

test("renameWorkset skips a stray file under inbox/", () => {
  saveWorkset(createWorkset("a"));
  writeJson(join(sub("inbox"), "stray.json"), {});
  renameWorkset("a", "b");
  expect(loadWorkset("b")).not.toBeNull();
});

const withWindow = (ws: string, tmuxUp: boolean, fn: () => void) => {
  const prev = { d: process.env.WORKBENCH_DRY_RUN, t: process.env.WORKBENCH_DRY_RUN_TMUX };
  process.env.WORKBENCH_DRY_RUN = "1";
  process.env.WORKBENCH_DRY_RUN_TMUX = JSON.stringify({ sessions: tmuxUp ? { [`wb-${ws}`]: { panes: [] } } : {} });
  writeJson(join(sub("windows"), `${ws}.json`), { workset: ws, hunkPaneId: "%1", hunkSessionId: "s", hunkPaneCwd: "/r", current: null, live: {}, threads: {} });
  try { fn(); } finally {
    if (prev.d === undefined) delete process.env.WORKBENCH_DRY_RUN; else process.env.WORKBENCH_DRY_RUN = prev.d;
    if (prev.t === undefined) delete process.env.WORKBENCH_DRY_RUN_TMUX; else process.env.WORKBENCH_DRY_RUN_TMUX = prev.t;
  }
};

test("rename is refused while a review window is open", () => {
  saveWorkset(createWorkset("a"));
  withWindow("a", true, () => {
    expect(() => renameWorkset("a", "b")).toThrow('workbench: "a" has a review window open; quit it first');
  });
  expect(loadWorkset("a")).not.toBeNull();
});

test("a stale window file without a tmux session does not block rename", () => {
  saveWorkset(createWorkset("a"));
  withWindow("a", false, () => { renameWorkset("a", "b"); });
  expect(loadWorkset("b")).not.toBeNull();
});
