import { existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import * as git from "./git";
import type * as hunk from "./hunk";
import { sub } from "./paths";
import { orderMembers } from "./stack";
import { readJson, writeJson, now, removeFile } from "./store";
import { ensureWindow, type Window } from "./window";
import { loadWorkset, type Member, type Workset } from "./workset";

// One batch of comments and edits against a workset, open from `r` (or `open --review`) until submit or close.
// The review window's state is not here: it lives in window.ts and outlives the review.
export type Review = {
  id: string; workset: string; opened: string;
  snapshot: Record<string, { tip: string; dirty: string[] }>;
  locked: string[];
};
export type Lock = { workset: string; review: string; paths: string[]; opened: string; holder: string };
export type Opened = { window: Window; review: Review | null };

const reviewFile = (ws: string) => join(sub("reviews"), `${ws}.json`);
const lockFile = (ws: string) => join(sub("locks"), `${ws}.json`);
const notesFile = (ws: string, memberId: string) => join(sub("reviews"), ws, "notes", `${memberId.replace(/[/#]/g, "_")}.json`);

export const archiveFile = (ws: string, id: string) => join(sub("reviews"), ws, `${id}.json`);

export const loadReview = (ws: string) => readJson<Review>(reviewFile(ws));
export const loadLock = (ws: string) => readJson<Lock>(lockFile(ws));
export const loadNotes = (ws: string, memberId: string) => readJson<hunk.RawNote[]>(notesFile(ws, memberId)) ?? [];
export const saveNotes = (ws: string, memberId: string, notes: hunk.RawNote[]) => writeJson(notesFile(ws, memberId), notes);
// Submit delivered the notes: drop every member's snapshot so the next review starts empty. Close keeps them.
export const clearNotes = (ws: string) => rmSync(join(sub("reviews"), ws, "notes"), { recursive: true, force: true });

export const saveReview = (r: Review): void => writeJson(reviewFile(r.workset), r);

export function config(): Config {
  try { return loadConfig(); } catch { return { default_branch: "main" } as Config; }
}

// Ends the open review: the review file goes first and the lock last, so agents stay held until nothing is pending.
export function releaseReview(ws: string): void {
  removeFile(reviewFile(ws));
  removeFile(lockFile(ws));
}

export const hasWorktree = (m: Member) => !!m.worktree && existsSync(m.worktree);

function reviewId(): string {
  const t = now().replace(/[-:]/g, "");
  const hex = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `r-${t.slice(0, 8)}-${t.slice(9, 15)}-${hex}`;
}

export const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// A member's id can change under an open review or window (a migration giving it a slug in place of the repo path,
// or `workset add` learning the slug). The review keys its snapshot and notes files by id, the window its current
// member and live notes, so re-key them to the ids the workset has now: a stale id matches the member with that
// branch whose repo path or slug is the id's prefix; the current member also by the worktree the hunk pane runs in.
// True when anything changed, so the caller saves.
export function reconcileIds(r: Review | null, w: Window | null, ws: Workset): boolean {
  const ids = new Set(ws.members.map((m) => m.id));
  const byStale = (id: string): Member | undefined => {
    const i = id.indexOf("#");
    if (i < 0) return undefined;
    const prefix = id.slice(0, i), branch = id.slice(i + 1);
    return ws.members.find((m) => m.branch === branch && (prefix === m.repo || prefix === m.slug || real(prefix) === real(m.repo)));
  };
  let changed = false;
  for (const old of Object.keys(r?.snapshot ?? {})) {
    if (ids.has(old)) continue;
    const m = byStale(old);
    if (!m || r!.snapshot[m.id]) continue;
    r!.snapshot[m.id] = r!.snapshot[old];
    delete r!.snapshot[old];
    const from = notesFile(ws.name, old), to = notesFile(ws.name, m.id);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    changed = true;
  }
  if (w?.current && !ids.has(w.current)) {
    const byCwd = w.hunkPaneCwd ? ws.members.find((m) => hasWorktree(m) && real(m.worktree!) === real(w.hunkPaneCwd!)) : undefined;
    const m = byStale(w.current) ?? byCwd;
    if (m) { w.current = m.id; changed = true; }
  }
  for (const old of Object.keys(w?.live ?? {})) {
    if (ids.has(old)) continue;
    const m = byStale(old);
    if (!m || w!.live[m.id]) continue;
    w!.live[m.id] = w!.live[old];
    delete w!.live[old];
    changed = true;
  }
  return changed;
}

// Working tree against the merge base, so uncommitted edits show; the plain range when merge-base fails. The base is
// read both as the local branch and at its upstream, and the later of the two merge bases wins: a local main that
// has fallen behind would make the merge base itself and the diff would carry every commit up to the branch's fork
// point; a stacked base with unpushed commits would, at its upstream, show those commits as the member's own.
export function diffRef(wt: string, base: string, branch: string): string {
  const local = git.mergeBase(wt, base, branch);
  const upstream = git.upstreamOf(wt, base);
  const remote = upstream ? git.mergeBase(wt, upstream, branch) : null;
  if (local && remote) return git.isAncestor(wt, local, remote) ? remote : local;
  return local ?? remote ?? `${base}...${branch}`;
}

const workMembers = (ws: Workset) => orderMembers(ws.members).filter((m) => m.role === "work" && hasWorktree(m));

// Starts a review: refuses on dirt or a worktree on the wrong branch, snapshots every member and locks the work
// worktrees. The window is not touched: the diff hunk shows does not change when a review starts.
export function startReview(name: string, opts: { allowDirty: boolean }): Review {
  const ws = loadWorkset(name);
  if (!ws) throw new Error(`workbench: no workset "${name}"`);
  if (loadReview(name)) throw new Error(`workbench: a review is already open for "${name}"`);
  const members = orderMembers(ws.members);
  const work = workMembers(ws);
  if (work.length === 0) throw new Error(`workbench: workset "${name}" has no work member with a worktree`);
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
  const r: Review = { id: reviewId(), workset: name, opened: now(), snapshot, locked: work.map((m) => m.worktree!) };
  writeJson(lockFile(name), { workset: name, review: r.id, paths: r.locked, opened: r.opened, holder: userInfo().username } satisfies Lock);
  saveReview(r);
  return r;
}

// Builds or repairs the review window, watching. With `review`, also starts a review first, so a refusal
// (dirt, wrong branch) leaves nothing behind; an open review is reused either way.
export function openReview(name: string, opts: { allowDirty: boolean; review?: boolean }): Opened {
  const ws = loadWorkset(name);
  if (!ws) throw new Error(`workbench: no workset "${name}"`);
  if (workMembers(ws).length === 0) throw new Error(`workbench: workset "${name}" has no work member with a worktree`);
  let review = loadReview(name);
  if (!review && opts.review) review = startReview(name, opts);
  const window = ensureWindow(name, ws, config());
  review = loadReview(name);
  return { window, review };
}
