import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { normaliseNotes, type Comment } from "./comments";
import * as git from "./git";
import { sub } from "./paths";
import { archiveFile, hasWorktree, loadNotes, loadReview, releaseReview, snapshotNotes, type Review } from "./review";
import { loadPointer } from "./session";
import { now, writeJson } from "./store";
import { loadWorkset, type Member, type Workset } from "./workset";

export type EditCommit = { repo: string; branch: string; sha: string; files: string[] };
export type ReviewFile = { id: string; workset: string; submitted: string; message: string | null; comments: Comment[]; edits: EditCommit[]; sessions: string[] };
export type SubmitOptions = { message?: string; prompt?: () => Promise<string>; log?: (line: string) => void };

export const DEFAULT_MESSAGE = "Review edits (workbench)";
export const inboxFile = (key: string, id: string) => join(sub("inbox"), key, `${id}.json`);

export async function ttyPrompt(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(`Review message (blank for "${DEFAULT_MESSAGE}"): `); } finally { rl.close(); }
}

function open(name: string): { ws: Workset; review: Review } {
  const ws = loadWorkset(name);
  if (!ws) throw new Error(`workbench: no workset "${name}"`);
  const review = loadReview(name);
  if (!review) throw new Error(`workbench: no open review for "${name}"`);
  return { ws, review };
}

// hunk holds the live member's notes only in memory; copy them to its snapshot file, the single source.
function snapshotCurrent(ws: Workset, review: Review): void {
  const live = ws.members.find((m) => m.id === review.current);
  if (live && hasWorktree(live)) snapshotNotes(review, live);
}

// Stages and commits only what changed since open; returns the commit or null when there is nothing to do.
function commitEdits(m: Member, review: Review, message: string, log: (s: string) => void): EditCommit | null {
  const wt = m.worktree!;
  const names = git.diffNames(wt), extra = git.untracked(wt);
  if (names === null || extra === null) { log(`  skipping ${m.id}: cannot read git status in ${wt}`); return null; }
  const before = new Set(review.snapshot[m.id]?.dirty ?? []);
  const files = [...new Set([...names, ...extra])].filter((f) => !before.has(f)).sort();
  if (files.length === 0) return null;
  const trailers = [`Workset: ${review.workset}`, `Review: ${review.id}`];
  const sha = git.add(wt, files) && git.commit(wt, message, trailers, files) ? git.revParse(wt, "HEAD") : null;
  if (!sha) { log(`  commit failed for ${m.id} in ${wt}; its edits are left uncommitted`); return null; }
  return { repo: m.repo, branch: m.branch, sha, files };
}

export async function submitReview(name: string, opts: SubmitOptions = {}): Promise<ReviewFile> {
  const log = opts.log ?? console.log;
  const { ws, review } = open(name);
  const asked = opts.message ?? (process.stdin.isTTY ? await (opts.prompt ?? ttyPrompt)() : "");
  const message = asked.trim() || null;
  snapshotCurrent(ws, review);

  // 1. Edit commits first: nothing reaches an inbox before they exist.
  const work = ws.members.filter((m) => m.role === "work");
  const edits: EditCommit[] = [], heads = new Map<string, string>();
  for (const m of work) {
    if (!hasWorktree(m)) { log(`  skipping ${m.id}: worktree ${m.worktree ?? "(none)"} is gone`); continue; }
    const e = commitEdits(m, review, message ?? DEFAULT_MESSAGE, log);
    if (e) edits.push(e);
    const head = git.revParse(m.worktree!, "HEAD");
    if (head) heads.set(m.id, head);
  }

  // 2. Comments from each member's note snapshot, anchored to the commit they now sit on.
  const comments = work.flatMap((m) => normaliseNotes(loadNotes(name, m.id), {
    member: m.id, repo: m.repo, slug: m.slug, branch: m.branch, sha: heads.get(m.id) ?? review.snapshot[m.id]?.tip ?? "",
  }));

  // 3. Deliver to every open bound session, then archive.
  const sessions = [...new Set(ws.sessions)].filter((k) => { const p = loadPointer(k); return !!p && p.closed === null; });
  const file: ReviewFile = { id: review.id, workset: name, submitted: now(), message, comments, edits, sessions };
  for (const k of sessions) writeJson(inboxFile(k, review.id), { ...file, read: false });
  writeJson(archiveFile(name, review.id), file);

  // 4. Release: the lock goes last.
  releaseReview(name);
  log(summary(file));
  return file;
}

export function summary(f: ReviewFile): string {
  const count = (t: Comment["type"]) => f.comments.filter((c) => c.type === t).length;
  return [
    `submitted ${f.id} for ${f.workset}`,
    ...(f.edits.length ? f.edits.map((e) => `  commit ${e.sha.slice(0, 7)} ${e.branch} (${e.files.length} file${e.files.length === 1 ? "" : "s"}) in ${e.repo}`) : ["  no edits to commit"]),
    `  comments: ${count("change")} change, ${count("question")} question, ${count("note")} note`,
    `  notified: ${f.sessions.length ? f.sessions.join(", ") : "no open session"}`,
  ].join("\n");
}

export const closedLine = (name: string, id: string) => `closed ${id} for ${name}: lock released, comments kept`;

// Leaves the review without submitting: notes are snapshotted and kept, the lock released, nothing committed.
// A review whose workset was deleted can still be closed, so its lock never sticks.
export function closeReview(name: string): string {
  const review = loadReview(name), ws = loadWorkset(name);
  if (!review) throw new Error(ws ? `workbench: no open review for "${name}"` : `workbench: no workset "${name}"`);
  if (ws) snapshotCurrent(ws, review);
  releaseReview(name);
  return review.id;
}
