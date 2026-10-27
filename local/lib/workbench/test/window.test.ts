import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson } from "../src/store";
import { loadWindow, newWindow, removeWindow, saveWindow, setHunkSession, windowFile, windowOpen } from "../src/window";

const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN", "WORKBENCH_DRY_RUN_TMUX"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let tmp: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-window-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_DRY_RUN = "1";
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test("setHunkSession resets live and threads only when the id changes", () => {
  const w = newWindow("ws1");
  w.live = { m: { "user:1": null } }; w.threads = { "mcp:1": "user:9" }; w.hunkSessionId = "a";
  setHunkSession(w, "a");
  expect(w.live).toEqual({ m: { "user:1": null } });
  expect(w.threads).toEqual({ "mcp:1": "user:9" });
  setHunkSession(w, "b");
  expect(w).toMatchObject({ hunkSessionId: "b", live: {}, threads: {} });
});

test("windowOpen needs both the file and the tmux session", () => {
  expect(windowOpen("ws1")).toBe(false);
  saveWindow(newWindow("ws1"));
  expect(windowOpen("ws1")).toBe(false);
  process.env.WORKBENCH_DRY_RUN_TMUX = JSON.stringify({ sessions: { "wb-ws1": { panes: [] } } });
  expect(windowOpen("ws1")).toBe(true);
});

test("saveWindow round-trips and removeWindow deletes", () => {
  const w = { ...newWindow("ws1"), hunkPaneId: "%1", hunkSessionId: "s", hunkPaneCwd: "/r", current: "/r#a", live: { "/r#a": { "user:1": null } } };
  saveWindow(w);
  expect(windowFile("ws1")).toBe(join(tmp, "state", "windows", "ws1.json"));
  const back = loadWindow("ws1")!;
  expect({ ...back, commands: undefined }).toEqual({ ...w, commands: undefined });
  removeWindow("ws1");
  expect(loadWindow("ws1")).toBeNull();
});

test("a review opened before the split still has its window: loadWindow reads the old review file's hunk fields", () => {
  writeJson(join(tmp, "state", "reviews", "ws1.json"), {
    id: "r-1", workset: "ws1", opened: "t", snapshot: {}, locked: [], current: "/r#a", hunkPaneId: "%4", hunkSessionId: "sid-9", hunkPaneCwd: "/r",
  });
  expect(loadWindow("ws1")).toEqual({ workset: "ws1", hunkPaneId: "%4", hunkSessionId: "sid-9", hunkPaneCwd: "/r", current: "/r#a", live: {}, threads: {} });
  writeJson(join(tmp, "state", "reviews", "ws2.json"), { id: "r-2", workset: "ws2", opened: "t", snapshot: {}, locked: [] });
  expect(loadWindow("ws2")).toBeNull();
});
