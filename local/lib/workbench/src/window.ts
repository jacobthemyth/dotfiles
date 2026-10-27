import { join } from "node:path";
import type { Config } from "./config";
import { normaliseNotes } from "./comments";
import * as hunk from "./hunk";
import { sub } from "./paths";
import { recordProxy, syncMember } from "./notes";
import { rehydrateReplies } from "./reply";
import { diffRef, hasWorktree, loadNotes, loadReview, real, reconcileIds, saveReview } from "./review";
import { diffBase, orderMembers } from "./stack";
import { dryRun, drainRecorded } from "./spawn";
import { readJson, removeFile, writeJson } from "./store";
import * as tmux from "./tmux";
import type { Member, Workset } from "./workset";

// The review window's state: the tmux session `wb-<ws>` with its sidebar and hunk. It outlives any one review.
export type Window = {
  workset: string; hunkPaneId: string | null; hunkSessionId: string | null; hunkPaneCwd: string | null; current: string | null;
  live: Record<string, Record<string, string | null>>; // member id → note id live in this hunk session → original id (a proxy) or null (own note)
  threads: Record<string, string>;                      // note id workbench added in this hunk session → archived comment id
  commands?: string[];                                  // dry-run argv log
};

export const windowFile = (ws: string) => join(sub("windows"), `${ws}.json`);
// A review opened before the window was split out kept the window's fields in reviews/<ws>.json: read them from
// there until the first save writes the window file, so submit and the sidebar still find the live hunk.
type Legacy = { current?: string | null; hunkPaneId?: string | null; hunkSessionId?: string | null; hunkPaneCwd?: string | null };
export function loadWindow(ws: string): Window | null {
  const w = readJson<Window>(windowFile(ws));
  if (w) return w;
  let old: Legacy | null = null;
  try { old = readJson<Legacy>(join(sub("reviews"), `${ws}.json`)); } catch { return null; }
  if (!old || !old.hunkPaneId) return null;
  return { workset: ws, hunkPaneId: old.hunkPaneId, hunkSessionId: old.hunkSessionId ?? null, hunkPaneCwd: old.hunkPaneCwd ?? null, current: old.current ?? null, live: {}, threads: {} };
}
export const removeWindow = (ws: string) => removeFile(windowFile(ws));
export const newWindow = (ws: string): Window =>
  ({ workset: ws, hunkPaneId: null, hunkSessionId: null, hunkPaneCwd: null, current: null, live: {}, threads: {} });

// The agent's process records threads into this file while the sidebar holds a copy across slow hunk calls:
// keep the file's thread entries for the same hunk session. Removals go through persistThreads, as deltas.
export function saveWindow(w: Window): void {
  if (dryRun()) w.commands = [...(w.commands ?? []), ...drainRecorded()];
  let fresh: Window | null = null;
  try { fresh = loadWindow(w.workset); } catch { /* corrupt: overwrite */ }
  if (fresh && fresh.hunkSessionId === w.hunkSessionId) w.threads = { ...fresh.threads, ...w.threads };
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

export const hunkTarget = (w: Window, m: Member): hunk.Target => ({ id: w.hunkSessionId, path: w.hunkPaneCwd ?? m.worktree! });
const SIDEBAR = (ws: string) => `workbench sidebar ${ws}`;
// hunk's `e` runs the edit guard, which opens the user's editor only while a review is open.
const guardEnv = (ws: string) => ({
  EDITOR: "workbench-edit-guard", VISUAL: "workbench-edit-guard", WORKBENCH_EDIT_WORKSET: ws, WORKBENCH_EDIT_EDITOR: process.env.VISUAL || process.env.EDITOR || "nvim",
});

// A fresh hunk holds none of the reviewer's notes: re-show `m`'s snapshotted ones as agent comments by "you".
// normaliseNotes keeps only source "user", so these are never delivered. A note already live is skipped
// (by note id, or a "you:" comment with the same body on the same file); if the live list cannot be
// fetched it comes back empty and every note is re-added.
function reshowOwnNotes(w: Window, m: Member): void {
  let raw: hunk.RawNote[];
  try { raw = loadNotes(w.workset, m.id); } catch { return; }
  const saved = normaliseNotes(raw);
  if (saved.length === 0) return;
  const t = hunkTarget(w, m);
  const live = hunk.allNotes(t);
  const ids = new Set(live.map((n) => n.noteId));
  const shown = new Set(live.filter((n) => n.author === "you").map((n) => `${n.filePath}\0${n.body}`));
  const body = new Map(raw.map((n) => [n.noteId, String(n.body ?? "").trim()]));
  for (const c of saved) {
    const summary = `you: ${body.get(c.id) || c.text}`;
    if (ids.has(c.id) || shown.has(`${c.path}\0${summary}`)) continue;
    const line = c.line.side === "old" ? { oldLine: c.line.start } : { newLine: c.line.start };
    const id = hunk.addAgentComment(t, { file: c.path, ...line, summary, author: "you" });
    if (id) recordProxy(w, m.id, id, c.id); // deleting the copy deletes the original
  }
}

// Runs hunk for `m` in `pane` (default: the recorded hunk pane), then looks for the session it registers
// and shows it the agent replies to `m`'s comments (a fresh hunk holds no notes).
function startHunk(w: Window, m: Member, base: string, pane = w.hunkPaneId): boolean {
  if (!pane || !hunk.start(pane, m.worktree!, diffRef(m.worktree!, base, m.branch), m.paths ?? [], guardEnv(w.workset))) return false;
  w.hunkPaneId = pane;
  w.hunkPaneCwd = m.worktree;
  w.current = m.id;
  setHunkSession(w, hunk.waitForSession(pane));
  reshowOwnNotes(w, m);
  rehydrateReplies(w, m);
  return true;
}

// Re-keys the window, and the open review if there is one, to the ids the workset has now; saves the review.
function reconcile(w: Window, ws: Workset): void {
  const r = loadReview(w.workset);
  if (reconcileIds(r, w, ws) && r) saveReview(r);
}

// Points the reviewer at another member (or a whole stack: base...top branch). hunk can only reload within
// the worktree it started in, so a member in another worktree gets a fresh hunk in the same pane.
export function repoint(w: Window, ws: Workset, to: Member, base: string): boolean {
  reconcile(w, ws);
  const live = ws.members.find((m) => m.id === w.current);
  if (live && hasWorktree(live)) syncMember(w, live);
  const same = !!w.hunkPaneCwd && real(w.hunkPaneCwd) === real(to.worktree!);
  let ok = same && hunk.reload(hunkTarget(w, to), to.worktree!, diffRef(to.worktree!, base, to.branch), to.paths ?? []);
  if (ok) { w.current = to.id; rehydrateReplies(w, to); }
  else ok = startHunk(w, to, base);
  saveWindow(w);
  return ok;
}

// A window left up without a usable record of its hunk: take over its live hunk (session id by pane), snapshot
// its notes for the member it shows, and show the replies it has not shown yet.
function adoptHunk(w: Window, ws: Workset, pane: string, fallback: Member): void {
  const cwd = tmux.paneCwd(pane);
  const m = (cwd && ws.members.find((x) => hasWorktree(x) && real(x.worktree!) === real(cwd))) || fallback;
  w.hunkPaneId = pane;
  w.hunkPaneCwd = m.worktree;
  w.current = m.id;
  setHunkSession(w, hunk.waitForSession(pane));
  syncMember(w, m);
  reshowOwnNotes(w, m);
  rehydrateReplies(w, m);
}

// Builds the review window, or repairs an existing one: a dead or missing hunk pane, a missing sidebar.
function buildOrRepair(w: Window, ws: Workset, first: Member, cfg: Config): void {
  const session = tmux.sessionName(w.workset), wt = first.worktree!;
  if (!tmux.hasSession(session)) {
    const pane = tmux.newSession(session, wt);
    if (!startHunk(w, first, diffBase(first, cfg), pane)) throw new Error(`workbench: could not start hunk in ${pane}`);
    tmux.splitSidebar(pane, wt, SIDEBAR(w.workset));
    return;
  }
  const live = ws.members.find((m) => m.id === w.current && hasWorktree(m)) ?? first;
  const panes = tmux.listPanes(session);
  const sidebar = panes.find((p) => p.start.includes(SIDEBAR(w.workset)));
  const hunkPane = panes.find((p) => p.id === w.hunkPaneId) ?? panes.find((p) => p.start.includes("hunk diff") || p.command === "hunk");
  if (!hunkPane) {
    const pane = tmux.splitRight((sidebar ?? panes[0])?.id ?? session, live.worktree!);
    if (!startHunk(w, live, diffBase(live, cfg), pane)) throw new Error(`workbench: could not start hunk in ${pane}`);
    if (sidebar) tmux.resizeWidth(sidebar.id, 44);
  } else if (hunkPane.dead) {
    if (!startHunk(w, live, diffBase(live, cfg), hunkPane.id)) throw new Error(`workbench: could not restart hunk in ${hunkPane.id}`);
  } else if (hunkPane.id !== w.hunkPaneId || !w.hunkSessionId) adoptHunk(w, ws, hunkPane.id, live);
  if (sidebar?.dead) tmux.respawn(sidebar.id, wt, ["workbench", "sidebar", w.workset]);
  else if (!sidebar) tmux.splitSidebar(w.hunkPaneId!, wt, SIDEBAR(w.workset));
}

// The window for `name`, built or repaired and saved. A window file whose tmux session is gone is discarded:
// its pane and hunk session ids name things that no longer exist.
export function ensureWindow(name: string, ws: Workset, cfg: Config): Window {
  const work = orderMembers(ws.members).filter((m) => m.role === "work" && hasWorktree(m));
  if (work.length === 0) throw new Error(`workbench: workset "${name}" has no work member with a worktree`);
  const up = tmux.hasSession(tmux.sessionName(name));
  const w = (up ? loadWindow(name) : null) ?? newWindow(name);
  reconcile(w, ws);
  const live = ws.members.find((m) => m.id === w.current && hasWorktree(m));
  if (up && live && w.hunkSessionId) syncMember(w, live);
  buildOrRepair(w, ws, work[0], cfg);
  saveWindow(w);
  return w;
}

