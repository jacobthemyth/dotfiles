import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import * as git from "./git";
import * as hunk from "./hunk";
import { sub } from "./paths";
import { dryRun, drainRecorded } from "./spawn";
import { diffBase, orderMembers } from "./stack";
import { readJson, writeJson, now } from "./store";
import * as tmux from "./tmux";
import { loadWorkset, type Member, type Workset } from "./workset";

export type Review = {
  id: string; workset: string; opened: string;
  snapshot: Record<string, { tip: string; dirty: string[] }>;
  locked: string[]; current: string | null; hunkSessionId: string | null; hunkPaneCwd: string | null;
  commands?: string[];
};
export type Lock = { workset: string; review: string; paths: string[]; opened: string; holder: string };

const reviewFile = (ws: string) => join(sub("reviews"), `${ws}.json`);
const lockFile = (ws: string) => join(sub("locks"), `${ws}.json`);
const notesFile = (ws: string, memberId: string) => join(sub("reviews"), ws, "notes", `${memberId.replace(/[/#]/g, "_")}.json`);

export const loadReview = (ws: string) => readJson<Review>(reviewFile(ws));
export const loadLock = (ws: string) => readJson<Lock>(lockFile(ws));
export const loadNotes = (ws: string, memberId: string) => readJson<hunk.RawNote[]>(notesFile(ws, memberId)) ?? [];

// Commands recorded by a dry run so far are appended to the review before it is written.
export function saveReview(r: Review): void {
  if (dryRun()) r.commands = [...(r.commands ?? []), ...drainRecorded()];
  writeJson(reviewFile(r.workset), r);
}

export function config(): Config {
  try { return loadConfig(); } catch { return { default_branch: "main" } as Config; }
}

const hasWorktree = (m: Member) => !!m.worktree && existsSync(m.worktree);
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

// Points the reviewer at another member (or a whole stack: base...top branch). hunk can only reload within
// the worktree it started in, so a member in another worktree gets a fresh hunk in the same pane.
export function repoint(r: Review, ws: Workset, to: Member, base: string): boolean {
  const live = ws.members.find((m) => m.id === r.current);
  if (live && hasWorktree(live)) snapshotNotes(r, live);
  const ok = hunk.reload(hunkTarget(r, to), to.worktree!, base, to.branch) || restartHunk(r, to, base);
  if (ok) r.current = to.id;
  saveReview(r);
  return ok;
}

function restartHunk(r: Review, to: Member, base: string): boolean {
  const pane = r.hunkSessionId ? hunk.paneOf(r.hunkSessionId) : null;
  if (!pane) return false;
  hunk.start(pane, to.worktree!, base, to.branch);
  r.hunkPaneCwd = to.worktree;
  r.hunkSessionId = hunk.waitForSession(to.worktree!);
  return true;
}

function openWindow(r: Review, first: Member, cfg: Config): void {
  const wt = first.worktree!;
  const { pane, created } = tmux.ensureSession(tmux.sessionName(r.workset), wt);
  if (!created) return;
  hunk.start(pane, wt, diffBase(first, cfg), first.branch);
  tmux.splitSidebar(pane, wt, `workbench sidebar ${r.workset}`);
  r.current = first.id;
  r.hunkPaneCwd = tmux.paneCwd(pane) ?? wt;
  r.hunkSessionId = hunk.waitForSession(wt);
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
    openWindow(existing, work[0], cfg);
    saveReview(existing);
    return existing;
  }

  const snapshot: Review["snapshot"] = {};
  const blocking: string[] = [];
  for (const m of members) {
    const dirty = hasWorktree(m) ? git.dirtyFiles(m.worktree!) ?? [] : [];
    if (m.role === "work") blocking.push(...dirty.map((f) => join(m.worktree!, f)));
    const tip = hasWorktree(m) ? git.revParse(m.worktree!, "HEAD") : git.revParse(m.repo, `refs/heads/${m.branch}`);
    if (tip) snapshot[m.id] = { tip, dirty };
  }
  if (blocking.length && !opts.allowDirty) {
    throw new Error(`workbench: uncommitted changes in work worktrees (commit them or pass --allow-dirty):\n  ${blocking.join("\n  ")}`);
  }
  const r: Review = {
    id: reviewId(), workset: name, opened: now(), snapshot, locked: work.map((m) => m.worktree!),
    current: work[0].id, hunkSessionId: null, hunkPaneCwd: null,
  };
  writeJson(lockFile(name), { workset: name, review: r.id, paths: r.locked, opened: r.opened, holder: userInfo().username } satisfies Lock);
  saveReview(r);
  openWindow(r, work[0], cfg);
  saveReview(r);
  return r;
}
