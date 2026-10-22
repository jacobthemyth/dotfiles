import { existsSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { normaliseNotes } from "./comments";
import * as git from "./git";
import * as hunk from "./hunk";
import { sub } from "./paths";
import { rehydrateReplies } from "./reply";
import { dryRun, drainRecorded } from "./spawn";
import { diffBase, orderMembers } from "./stack";
import { readJson, writeJson, now, removeFile } from "./store";
import * as tmux from "./tmux";
import { loadWorkset, type Member, type Workset } from "./workset";

export type Review = {
  id: string; workset: string; opened: string;
  snapshot: Record<string, { tip: string; dirty: string[] }>;
  locked: string[]; current: string | null;
  hunkPaneId: string | null; hunkSessionId: string | null; hunkPaneCwd: string | null;
  commands?: string[];
};
export type Lock = { workset: string; review: string; paths: string[]; opened: string; holder: string };

const reviewFile = (ws: string) => join(sub("reviews"), `${ws}.json`);
const lockFile = (ws: string) => join(sub("locks"), `${ws}.json`);
const notesFile = (ws: string, memberId: string) => join(sub("reviews"), ws, "notes", `${memberId.replace(/[/#]/g, "_")}.json`);

export const archiveFile = (ws: string, id: string) => join(sub("reviews"), ws, `${id}.json`);

export const loadReview = (ws: string) => readJson<Review>(reviewFile(ws));
export const loadLock = (ws: string) => readJson<Lock>(lockFile(ws));
export const loadNotes = (ws: string, memberId: string) => readJson<hunk.RawNote[]>(notesFile(ws, memberId)) ?? [];
// Submit delivered the notes: drop every member's snapshot so the next review starts empty. Close keeps them.
export const clearNotes = (ws: string) => rmSync(join(sub("reviews"), ws, "notes"), { recursive: true, force: true });

// The review window has no use once a review is submitted; a later open builds a fresh one.
export function killWindow(ws: string): void {
  const session = tmux.sessionName(ws);
  if (tmux.hasSession(session)) tmux.killSession(session);
}

// Commands recorded by a dry run so far are appended to the review before it is written.
export function saveReview(r: Review): void {
  if (dryRun()) r.commands = [...(r.commands ?? []), ...drainRecorded()];
  writeJson(reviewFile(r.workset), r);
}

export function config(): Config {
  try { return loadConfig(); } catch { return { default_branch: "main" } as Config; }
}

// Ends the open review: the review file goes first and the lock last, so agents stay held until nothing is pending.
export function releaseReview(ws: string): void {
  removeFile(reviewFile(ws));
  removeFile(lockFile(ws));
}

export const hasWorktree = (m: Member) => !!m.worktree && existsSync(m.worktree);
export const hunkTarget = (r: Review, m: Member): hunk.Target => ({ id: r.hunkSessionId, path: r.hunkPaneCwd ?? m.worktree! });

function reviewId(): string {
  const t = now().replace(/[-:]/g, "");
  const hex = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `r-${t.slice(0, 8)}-${t.slice(9, 15)}-${hex}`;
}

// User notes live only in hunk's memory; copy what it holds now for the live member, merged by noteId.
export function snapshotNotes(r: Review, m: Member): hunk.RawNote[] {
  const fresh = hunk.userComments(hunkTarget(r, m));
  const merged = new Map(loadNotes(r.workset, m.id).map((n) => [n.noteId, n]));
  for (const n of fresh) merged.set(n.noteId, n);
  const out = [...merged.values()];
  writeJson(notesFile(r.workset, m.id), out);
  return out;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const SIDEBAR = (ws: string) => `workbench sidebar ${ws}`;

// Working tree against the merge base, so uncommitted edits show; the plain range when merge-base fails. The base is
// taken at its upstream when it has one: a local default branch that has fallen behind would make the merge base
// itself, and the diff would carry every commit between it and the branch's fork point as the member's own.
export function diffRef(wt: string, base: string, branch: string): string {
  const ref = git.upstreamOf(wt, base) ?? base;
  return git.mergeBase(wt, ref, branch) ?? `${ref}...${branch}`;
}

// A fresh hunk holds none of the reviewer's notes: re-show `m`'s snapshotted ones as agent comments by "you".
// normaliseNotes keeps only source "user", so these are never delivered. A note already live is skipped
// (by note id, or a "you:" comment with the same body on the same file); if the live list cannot be
// fetched it comes back empty and every note is re-added.
function reshowOwnNotes(r: Review, m: Member): void {
  let raw: hunk.RawNote[];
  try { raw = loadNotes(r.workset, m.id); } catch { return; }
  const saved = normaliseNotes(raw);
  if (saved.length === 0) return;
  const t = hunkTarget(r, m);
  const live = hunk.allNotes(t);
  const ids = new Set(live.map((n) => n.noteId));
  const shown = new Set(live.filter((n) => n.author === "you").map((n) => `${n.filePath}\0${n.body}`));
  const body = new Map(raw.map((n) => [n.noteId, String(n.body ?? "").trim()]));
  for (const c of saved) {
    const summary = `you: ${body.get(c.id) || c.text}`;
    if (ids.has(c.id) || shown.has(`${c.path}\0${summary}`)) continue;
    const line = c.line.side === "old" ? { oldLine: c.line.start } : { newLine: c.line.start };
    hunk.addAgentComment(t, { file: c.path, ...line, summary, author: "you" });
  }
}

// Runs hunk for `m` in `pane` (default: the recorded hunk pane), then looks for the session it registers
// and shows it the agent replies to `m`'s comments (a fresh hunk holds no notes).
function startHunk(r: Review, m: Member, base: string, pane = r.hunkPaneId): boolean {
  if (!pane || !hunk.start(pane, m.worktree!, diffRef(m.worktree!, base, m.branch))) return false;
  r.hunkPaneId = pane;
  r.hunkPaneCwd = m.worktree;
  r.current = m.id;
  r.hunkSessionId = hunk.waitForSession(pane);
  reshowOwnNotes(r, m);
  rehydrateReplies(r, m);
  return true;
}

// Points the reviewer at another member (or a whole stack: base...top branch). hunk can only reload within
// the worktree it started in, so a member in another worktree gets a fresh hunk in the same pane.
export function repoint(r: Review, ws: Workset, to: Member, base: string): boolean {
  const live = ws.members.find((m) => m.id === r.current);
  if (live && hasWorktree(live)) snapshotNotes(r, live);
  const same = !!r.hunkPaneCwd && real(r.hunkPaneCwd) === real(to.worktree!);
  let ok = same && hunk.reload(hunkTarget(r, to), to.worktree!, diffRef(to.worktree!, base, to.branch));
  if (ok) { r.current = to.id; rehydrateReplies(r, to); }
  else ok = startHunk(r, to, base);
  saveReview(r);
  return ok;
}

// A window left up by an earlier review: take over its live hunk (session id by pane), snapshot its notes
// for the member it shows, and show the replies it has not shown yet.
function adoptHunk(r: Review, ws: Workset, pane: string, fallback: Member): void {
  const cwd = tmux.paneCwd(pane);
  const m = (cwd && ws.members.find((x) => hasWorktree(x) && real(x.worktree!) === real(cwd))) || fallback;
  r.hunkPaneId = pane;
  r.hunkPaneCwd = m.worktree;
  r.current = m.id;
  r.hunkSessionId = hunk.waitForSession(pane);
  snapshotNotes(r, m);
  reshowOwnNotes(r, m);
  rehydrateReplies(r, m);
}

// Builds the review window, or repairs an existing one: a dead or missing hunk pane, a missing sidebar.
function openWindow(r: Review, ws: Workset, first: Member, cfg: Config): void {
  const session = tmux.sessionName(r.workset), wt = first.worktree!;
  if (!tmux.hasSession(session)) {
    const pane = tmux.newSession(session, wt);
    if (!startHunk(r, first, diffBase(first, cfg), pane)) throw new Error(`workbench: could not start hunk in ${pane}`);
    tmux.splitSidebar(pane, wt, SIDEBAR(r.workset));
    return;
  }
  const live = ws.members.find((m) => m.id === r.current && hasWorktree(m)) ?? first;
  const panes = tmux.listPanes(session);
  const sidebar = panes.find((p) => p.start.includes(SIDEBAR(r.workset)));
  const hunkPane = panes.find((p) => p.id === r.hunkPaneId) ?? panes.find((p) => p.start.includes("hunk diff") || p.command === "hunk");
  if (!hunkPane) {
    const pane = tmux.splitRight((sidebar ?? panes[0])?.id ?? session, live.worktree!);
    if (!startHunk(r, live, diffBase(live, cfg), pane)) throw new Error(`workbench: could not start hunk in ${pane}`);
    if (sidebar) tmux.resizeWidth(sidebar.id, 44);
  } else if (hunkPane.dead) {
    if (!startHunk(r, live, diffBase(live, cfg), hunkPane.id)) throw new Error(`workbench: could not restart hunk in ${hunkPane.id}`);
  } else if (hunkPane.id !== r.hunkPaneId || !r.hunkSessionId) adoptHunk(r, ws, hunkPane.id, live);
  if (sidebar?.dead) tmux.respawn(sidebar.id, wt, ["workbench", "sidebar", r.workset]);
  else if (!sidebar) tmux.splitSidebar(r.hunkPaneId!, wt, SIDEBAR(r.workset));
}

export function openReview(name: string, opts: { allowDirty: boolean }): Review {
  const ws = loadWorkset(name);
  if (!ws) throw new Error(`workbench: no workset "${name}"`);
  const cfg = config();
  const members = orderMembers(ws.members);
  const work = members.filter((m) => m.role === "work" && hasWorktree(m));
  if (work.length === 0) throw new Error(`workbench: workset "${name}" has no work member with a worktree`);

  const existing = loadReview(name);
  if (existing) {
    const live = ws.members.find((m) => m.id === existing.current);
    if (live && hasWorktree(live)) snapshotNotes(existing, live);
    openWindow(existing, ws, work[0], cfg);
    saveReview(existing);
    return existing;
  }

  const snapshot: Review["snapshot"] = {};
  const blocking: string[] = [];
  for (const m of members) {
    const status = hasWorktree(m) ? git.dirtyFiles(m.worktree!) : [];
    if (status === null && m.role === "work") throw new Error(`workbench: cannot read git status in ${m.worktree} (${m.id}); refusing to open`);
    // Submit commits on whatever the worktree has checked out: it must be the member's branch.
    const on = m.role === "work" && hasWorktree(m) ? git.currentBranch(m.worktree!) : m.branch;
    if (on !== m.branch) throw new Error(`workbench: worktree ${m.worktree} has ${on ?? "a detached HEAD"} checked out, not ${m.branch} (${m.id}); refusing to open`);
    const dirty = status ?? [];
    if (m.role === "work") blocking.push(...dirty.map((f) => join(m.worktree!, f)));
    const tip = hasWorktree(m) ? git.revParse(m.worktree!, "HEAD") : git.revParse(m.repo, `refs/heads/${m.branch}`);
    if (tip) snapshot[m.id] = { tip, dirty };
  }
  if (blocking.length && !opts.allowDirty) {
    throw new Error(`workbench: uncommitted changes in work worktrees (commit them or pass --allow-dirty):\n  ${blocking.join("\n  ")}`);
  }
  const r: Review = {
    id: reviewId(), workset: name, opened: now(), snapshot, locked: work.map((m) => m.worktree!),
    current: work[0].id, hunkPaneId: null, hunkSessionId: null, hunkPaneCwd: null,
  };
  writeJson(lockFile(name), { workset: name, review: r.id, paths: r.locked, opened: r.opened, holder: userInfo().username } satisfies Lock);
  saveReview(r);
  openWindow(r, ws, work[0], cfg);
  saveReview(r);
  return r;
}
