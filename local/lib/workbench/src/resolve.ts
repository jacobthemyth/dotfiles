import { join } from "node:path";
import { parseResolve, type Comment, type ThreadedReply } from "./comments";
import * as hunk from "./hunk";
import { sub } from "./paths";
import { updateReviewFile } from "./reply";
import { archiveFile } from "./review";
import { listJson, now, readJson, removeFile, writeJson } from "./store";
import { inboxFile, type ReviewFile } from "./submit";
import { loadWindow, windowFile, type Window } from "./window";
import type { Member } from "./workset";

// Comment ids resolved since the last submit; drained into the next review file so the agent hears of them.
export const pendingFile = (ws: string) => join(sub("reviews"), ws, "resolved-pending.json");
export const UNKNOWN_THREAD = "cannot resolve: unknown thread";

const archives = (ws: string): ReviewFile[] => {
  const out: ReviewFile[] = [];
  for (const id of listJson(join(sub("reviews"), ws))) {
    try { const f = readJson<ReviewFile>(archiveFile(ws, id)); if (f && Array.isArray(f.comments)) out.push(f); } catch { /* corrupt: skip */ }
  }
  return out;
};

export function findArchived(ws: string, commentId: string): { reviewId: string; comment: Comment; sessions: string[] } | null {
  for (const f of archives(ws)) {
    const c = f.comments.find((x) => x.id === commentId);
    if (c) return { reviewId: f.id, comment: c, sessions: f.sessions };
  }
  return null;
}

// Every comment id a submit has delivered: such a note, still on screen in a window that outlived the submit,
// must not be snapshotted into the next review.
export const archivedCommentIds = (ws: string): Set<string> => new Set(archives(ws).flatMap((f) => f.comments.map((c) => c.id)));

function queue(ws: string, id: string): void {
  const ids = readJson<string[]>(pendingFile(ws)) ?? [];
  if (!ids.includes(id)) writeJson(pendingFile(ws), [...ids, id]);
}

export function drainResolved(ws: string): string[] {
  let ids: string[] = [];
  try { ids = readJson<string[]>(pendingFile(ws)) ?? []; } catch { /* corrupt: drop */ }
  removeFile(pendingFile(ws));
  return ids;
}

// Removes thread entries from the window file as it is now (a delta: entries another process added survive),
// unless the file has moved to another hunk session.
export function persistThreads(w: Window, removed: string[]): void {
  const fresh = loadWindow(w.workset);
  if (!fresh || fresh.hunkSessionId !== w.hunkSessionId) return;
  const threads = { ...fresh.threads };
  for (const id of removed) delete threads[id];
  writeJson(windowFile(w.workset), { ...fresh, threads });
}

const target = (w: Window): hunk.Target => ({ id: w.hunkSessionId, path: w.hunkPaneCwd ?? "" });

// Resolves an archived comment: marks it in the archive and every inbox copy, queues it for the next review, and
// removes from hunk `first` and then the thread's notes on screen, children before the note they reply to (hunk
// refuses to remove a note that still has replies). False when no archive holds the comment.
export function resolveThread(w: Window, commentId: string, text: string, onScreen: Set<string>, first: string[] = [], by = "you"): boolean {
  const found = findArchived(w.workset, commentId);
  if (!found) return false;
  const resolved = { at: now(), by, text };
  const mark = (f: ReviewFile): boolean => {
    const c = f.comments.find((x) => x.id === commentId);
    if (!c || c.resolved) return false;
    c.resolved = resolved;
    return true;
  };
  updateReviewFile(archiveFile(w.workset, found.reviewId), mark);
  for (const key of found.sessions) updateReviewFile(inboxFile(key, found.reviewId), mark);
  queue(w.workset, commentId);
  // Read the file too: a reply note the agent added for this comment during the sync belongs to the thread.
  const known = { ...(loadWindow(w.workset)?.threads ?? {}), ...w.threads };
  const shown = Object.keys(known).filter((id) => known[id] === commentId);
  for (const id of [...first, ...shown.filter((id) => onScreen.has(id)), ...(onScreen.has(commentId) ? [commentId] : [])]) hunk.rmComment(target(w), id);
  for (const id of shown) delete w.threads[id];
  persistThreads(w, shown);
  return true;
}

// Acts on the `/resolve` replies among `replies`: a thread workbench showed, a delivered note still on screen, or
// one of the reviewer's own un-submitted notes (dropped, as if deleted). Returns the notes without the dropped ones,
// and a warning for each `/resolve` whose parent is none of these (left on screen).
export function applyResolutions(w: Window, m: Member, replies: ThreadedReply[], onScreen: Set<string>, notes: hunk.RawNote[]): { notes: hunk.RawNote[]; warnings: string[] } {
  const warnings: string[] = [];
  let kept = notes;
  for (const reply of replies) {
    const cmd = parseResolve(reply.body);
    if (!cmd) continue;
    const thread = w.threads[reply.parentId] ?? reply.parentId;
    if (resolveThread(w, thread, cmd.text, onScreen, [reply.id])) continue;
    const live = w.live[m.id] ?? {};
    const own = live[reply.parentId] ?? (kept.some((n) => n.noteId === reply.parentId) ? reply.parentId : undefined);
    if (own === undefined) { warnings.push(UNKNOWN_THREAD); continue; }
    kept = kept.filter((n) => n.noteId !== own);
    for (const id of [reply.id, reply.parentId]) hunk.rmComment(target(w), id);
    const rest = { ...live };
    delete rest[reply.parentId];
    w.live[m.id] = rest;
  }
  return { notes: kept, warnings };
}
