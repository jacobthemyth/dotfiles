import { join } from "node:path";
import { sub } from "./paths";
import { dryRun, drainRecorded } from "./spawn";
import { readJson, removeFile, writeJson } from "./store";
import * as tmux from "./tmux";

// The review window's state: the tmux session `wb-<ws>` with its sidebar and hunk. It outlives any one review.
export type Window = {
  workset: string; hunkPaneId: string | null; hunkSessionId: string | null; hunkPaneCwd: string | null; current: string | null;
  live: Record<string, Record<string, string | null>>; // member id → note id live in this hunk session → original id (a proxy) or null (own note)
  threads: Record<string, string>;                      // note id workbench added in this hunk session → archived comment id
  commands?: string[];                                  // dry-run argv log
};

export const windowFile = (ws: string) => join(sub("windows"), `${ws}.json`);
export const loadWindow = (ws: string) => readJson<Window>(windowFile(ws));
export const removeWindow = (ws: string) => removeFile(windowFile(ws));
export const newWindow = (ws: string): Window =>
  ({ workset: ws, hunkPaneId: null, hunkSessionId: null, hunkPaneCwd: null, current: null, live: {}, threads: {} });

export function saveWindow(w: Window): void {
  if (dryRun()) w.commands = [...(w.commands ?? []), ...drainRecorded()];
  writeJson(windowFile(w.workset), w);
}

// The live and thread maps describe one hunk session's notes: a new session holds none of them.
export function setHunkSession(w: Window, sid: string | null): void {
  if (sid === w.hunkSessionId) return;
  w.hunkSessionId = sid;
  w.live = {};
  w.threads = {};
}

// A window file whose tmux session is gone is stale: it neither blocks rename or prune nor is trusted by open.
export const windowOpen = (ws: string): boolean => loadWindow(ws) !== null && tmux.hasSession(tmux.sessionName(ws));
