import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { normaliseNotes, type Comment } from "./comments";
import * as git from "./git";
import { sub } from "./paths";
import { archiveFile, clearNotes, hasWorktree, loadLock, loadNotes, loadReview, reconcileIds, releaseReview, saveReview, type Review } from "./review";
import { syncMember } from "./notes";
import { loadWindow, saveWindow, type Window } from "./window";
import { loadPointer, pointerKeys } from "./session";
import { now, writeJson } from "./store";
import { loadWorkset, type Member, type Workset } from "./workset";

export type EditCommit = { repo: string; branch: string; sha: string; files: string[] };
export type FailedEdit = { repo: string; branch: string; files: string[]; error: string };
export type ReviewFile = {
  id: string; workset: string; submitted: string; message: string | null;
  comments: Comment[]; edits: EditCommit[]; failed: FailedEdit[]; sessions: string[];
};
export type SubmitOptions = {
  message?: string; prompt?: () => Promise<string>; log?: (line: string) => void; warn?: (line: string) => void;
};

export const DEFAULT_MESSAGE = "Review edits (workbench)";
export const inboxFile = (key: string, id: string) => join(sub("inbox"), key, `${id}.json`);

export async function ttyPrompt(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(`Review message (blank for "${DEFAULT_MESSAGE}"): `); } finally { rl.close(); }
}

function open(name: string): { ws: Workset; review: Review; window: Window | null } {
  const ws = loadWorkset(name);
  if (!ws) throw new Error(`workbench: no workset "${name}"`);
  const review = loadReview(name);
  if (!review) throw new Error(`workbench: no open review for "${name}"`);
  const window = loadWindow(name);
  if (reconcileIds(review, window, ws)) { saveReview(review); if (window) saveWindow(window); }
  return { ws, review, window };
}

// A corrupt state file is reported and treated as absent: no single file may abort a submit or close.
function tolerant<T>(what: string, read: () => T, fallback: T, warn: (s: string) => void): T {
  try { return read(); } catch (e) { warn(`workbench: ignoring unreadable ${what}: ${(e as Error).message}`); return fallback; }
}

// hunk holds the live member's notes only in memory; copy them to its snapshot file, the single source.
function snapshotCurrent(ws: Workset, w: Window | null, warn: (s: string) => void): void {
  const live = w && ws.members.find((m) => m.id === w.current);
  if (w && live && hasWorktree(live)) tolerant(`notes snapshot for ${live.id}`, () => syncMember(w, live).notes, [], warn);
}

type Outcome = { edit: EditCommit } | { failed: FailedEdit } | null;
// Stages and commits only what changed since open; null when there is nothing to do. On failure the files
// are taken back out of the index, so the agent's index is as it was.
function commitEdits(m: Member, review: Review, message: string, log: (s: string) => void): Outcome {
  const wt = m.worktree!;
  const on = git.currentBranch(wt);
  if (on !== m.branch) { log(`  skipping ${m.id}: ${wt} has ${on ?? "a detached HEAD"} checked out, not ${m.branch}`); return null; }
  const names = git.diffNames(wt), extra = git.untracked(wt);
  if (names === null || extra === null) { log(`  skipping ${m.id}: cannot read git status in ${wt}`); return null; }
  const before = new Set(review.snapshot[m.id]?.dirty ?? []);
  const files = [...new Set([...names, ...extra])].filter((f) => !before.has(f)).sort();
  if (files.length === 0) return null;
  const trailers = [`Workset: ${review.workset}`, `Review: ${review.id}`];
  const error = git.add(wt, files) ?? git.commit(wt, message, trailers, files);
  const sha = error ? null : git.revParse(wt, "HEAD");
  if (!sha) {
    git.unstage(wt, files);
    log(`  commit failed for ${m.id}; ${files.length} file${files.length === 1 ? "" : "s"} left unstaged in ${wt}`);
    return { failed: { repo: m.repo, branch: m.branch, files, error: error ?? "no HEAD after commit" } };
  }
  return { edit: { repo: m.repo, branch: m.branch, sha, files } };
}

export async function submitReview(name: string, opts: SubmitOptions = {}): Promise<ReviewFile> {
  const log = opts.log ?? console.log, warn = opts.warn ?? console.error;
  const { ws, review, window } = open(name);
  const asked = opts.message ?? (process.stdin.isTTY ? await (opts.prompt ?? ttyPrompt)() : "");
  const message = asked.trim() || null;

  // 1. Read every state file first: once a commit exists, nothing may throw before delivery.
  snapshotCurrent(ws, window, warn);
  // Only the members this review opened on and locked: one recorded since was never reviewed or locked.
  const reviewed = (m: Member) => !!review.snapshot[m.id] && !!m.worktree && review.locked.includes(m.worktree);
  const work: Member[] = [];
  for (const m of ws.members.filter((x) => x.role === "work")) {
    if (reviewed(m)) work.push(m); else log(`  skipping ${m.id}: joined after open`);
  }
  const notes = new Map(work.map((m) => [m.id, normaliseNotes(
    tolerant(`notes snapshot for ${m.id}`, () => loadNotes(name, m.id), [], warn),
    { member: m.id, repo: m.repo, slug: m.slug, branch: m.branch, sha: "" },
  )]));
  // Pointers say who is bound now; ws.sessions is only the history of who ever joined.
  const sessions = pointerKeys().filter((k) => {
    const p = tolerant(`session pointer ${k}`, () => loadPointer(k), null, warn);
    return !!p && p.workset === name && p.closed === null;
  });

  // 2. Edit commits: nothing reaches an inbox before they exist.
  const edits: EditCommit[] = [], failed: FailedEdit[] = [];
  for (const m of work) {
    if (!hasWorktree(m)) { log(`  skipping ${m.id}: worktree ${m.worktree ?? "(none)"} is gone`); continue; }
    const o = commitEdits(m, review, message ?? DEFAULT_MESSAGE, log);
    if (o && "edit" in o) edits.push(o.edit);
    if (o && "failed" in o) failed.push(o.failed);
  }

  // 3. Anchor each comment to the commit its member now sits on (the snapshot tip if the worktree is gone).
  const comments = work.flatMap((m) => {
    const sha = (hasWorktree(m) ? git.revParse(m.worktree!, "HEAD") : null) ?? review.snapshot[m.id]?.tip ?? "";
    return notes.get(m.id)!.map((c) => ({ ...c, sha }));
  });

  // 4. Deliver to every open bound session, then archive.
  const file: ReviewFile = { id: review.id, workset: name, submitted: now(), message, comments, edits, failed, sessions };
  for (const k of sessions) writeJson(inboxFile(k, review.id), { ...file, read: false });
  writeJson(archiveFile(name, review.id), file);
  clearNotes(name); // delivered: the next review must not send them again

  // 5. Release: the lock goes last. Then the window, which may be the pane running this.
  releaseReview(name);
  log(summary(file));
  return file;
}

export function summary(f: ReviewFile): string {
  const count = (t: Comment["type"]) => f.comments.filter((c) => c.type === t).length;
  return [
    `submitted ${f.id} for ${f.workset}`,
    ...(f.edits.length ? f.edits.map((e) => `  commit ${e.sha.slice(0, 7)} ${e.branch} (${e.files.length} file${e.files.length === 1 ? "" : "s"}) in ${e.repo}`) : ["  no edits to commit"]),
    ...f.failed.map((x) => `  FAILED ${x.branch} (${x.files.length} file${x.files.length === 1 ? "" : "s"} left unstaged) in ${x.repo}: ${x.error}`),
    `  comments: ${count("change")} change, ${count("question")} question, ${count("note")} note`,
    `  notified: ${f.sessions.length ? f.sessions.join(", ") : "no open session"}`,
  ].join("\n");
}

export const closedLine = (name: string, id: string) => `closed ${id} for ${name}: lock released, comments kept`;

// Leaves the review without submitting: notes are snapshotted and kept, the lock released, nothing committed.
// A review whose workset was deleted can still be closed, and so can a lock whose review file is gone
// (an open that failed part-way), so a lock never sticks.
export function closeReview(name: string): string {
  const review = loadReview(name), ws = loadWorkset(name);
  if (!review) {
    const lock = loadLock(name);
    if (lock) { releaseReview(name); return lock.review; }
    throw new Error(ws ? `workbench: no open review for "${name}"` : `workbench: no workset "${name}"`);
  }
  if (ws) {
    const window = loadWindow(name);
    if (reconcileIds(review, window, ws) && window) saveWindow(window);
    snapshotCurrent(ws, window, console.error);
  }
  releaseReview(name);
  return review.id;
}
