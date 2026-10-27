import { join } from "node:path";
import type { Comment, Reply } from "./comments";
import * as hunk from "./hunk";
import { sub } from "./paths";
import { archiveFile } from "./review";
import { listJson, now, readJson, writeJson } from "./store";
import { inboxFile, type ReviewFile } from "./submit";
import { loadWindow, windowFile, type Window } from "./window";
import type { Member } from "./workset";

const load = (path: string): ReviewFile | null => { try { return readJson<ReviewFile>(path); } catch { return null; } };
const sameReply = (a: Reply, b: Reply) => a.at === b.at && a.by === b.by && a.text === b.text;

// The agent (addReply) and the sidebar (rehydrateReplies) write the same files from different processes,
// around slow hunk calls. Every write re-reads the file just before it and applies one small mutation,
// so neither side writes back a copy it read before a subprocess ran. Writes only when something changed.
export function updateReviewFile(path: string, mutate: (f: ReviewFile) => boolean): boolean {
  const f = load(path);
  if (!f || !mutate(f)) return false;
  writeJson(path, f); // the whole file round-trips, so an inbox copy keeps its read flag
  return true;
}
const findReply = (f: ReviewFile, commentId: string, r: Reply) => f.comments.find((c) => c.id === commentId)?.replies?.find((x) => sameReply(x, r));
const appendReply = (commentId: string, r: Reply) => (f: ReviewFile): boolean => {
  const c = f.comments.find((x) => x.id === commentId);
  if (!c || findReply(f, commentId, r)) return false;
  c.replies = [...(c.replies ?? []), { ...r }];
  return true;
};
const markShown = (commentId: string, r: Reply, sid: string) => (f: ReviewFile): boolean => {
  const hit = findReply(f, commentId, r);
  if (!hit || hit.shown_in?.includes(sid)) return false;
  hit.shown_in = [...(hit.shown_in ?? []), sid];
  return true;
};

// Tests only: runs right before each hunk comment add, to simulate a concurrent writer.
export const testHooks: { beforeShow?: () => void } = {};

// Shows one reply in a live hunk session: threaded under the user's note while it is still live there,
// else as an agent comment on the comment's line. `live` holds the session's note ids.
// Returns the new note's id, or null when hunk refused it.
function show(sessionId: string, c: Comment, r: Reply, live: Set<string>): string | null {
  testHooks.beforeShow?.();
  const t: hunk.Target = { id: sessionId, path: "" };
  const summary = `↩ ${r.text}`;
  if (live.has(c.id)) return hunk.addAgentComment(t, { replyTo: c.id, summary, author: r.by });
  const line = c.line.side === "old" ? { oldLine: c.line.start } : { newLine: c.line.start };
  return hunk.addAgentComment(t, { file: c.path, ...line, summary, rationale: `re: ${c.text}`, author: r.by });
}

// A note workbench added for a thread: `/resolve` under it resolves that thread. Written into the window file only
// while it still names this hunk session.
export function recordThread(ws: string, sessionId: string, noteId: string, commentId: string): void {
  const w = loadWindow(ws);
  if (!w || w.hunkSessionId !== sessionId) return;
  w.threads = { ...w.threads, [noteId]: commentId };
  writeJson(windowFile(ws), w);
}
const liveNotes = (sessionId: string) => new Set(hunk.allNotes({ id: sessionId, path: "" }).map((n) => n.noteId));

// Appends the reply to the session's inbox copy and the archive, showing it first when the review window
// has the comment's member open in a live hunk session, so both copies carry the same shown_in.
export function addReply(sessionKey: string, reviewId: string, commentId: string, text: string): { reply: Reply; shown: boolean; resolved: boolean } {
  const mine = inboxFile(sessionKey, reviewId);
  const read = load(mine);
  if (!read) throw new Error(`workbench: no review "${reviewId}" in ${sessionKey}`);
  const c = read.comments.find((x) => x.id === commentId);
  if (!c) throw new Error(`workbench: no comment "${commentId}" in review ${reviewId}`);

  const reply: Reply = { at: now(), by: sessionKey, text };
  const w = loadWindow(read.workset);
  const sid = w?.current === c.member ? w.hunkSessionId : null;
  // A resolved thread keeps a late reply in the files but is not re-opened on screen.
  const resolved = !!c.resolved;
  const id = !resolved && !!sid && hunk.hasSession(sid) ? show(sid, c, reply, liveNotes(sid)) : null;
  const shown = id !== null;
  if (shown) { reply.shown_in = [sid!]; recordThread(read.workset, sid!, id, c.id); }
  for (const path of [mine, archiveFile(read.workset, reviewId)]) updateReviewFile(path, appendReply(commentId, reply));
  return { reply, shown, resolved };
}

// Shows, in the review's current hunk session, every archived reply to this member's comments that the
// session has not shown yet. Each shown reply is recorded at once (archive, then each inbox copy), so a
// crash part-way leaves at most the reply in flight unrecorded.
export function rehydrateReplies(w: Window, member: Member): void {
  const sid = w.hunkSessionId;
  if (!sid) return;
  let live: Set<string> | null = null;
  for (const id of listJson(join(sub("reviews"), w.workset))) {
    const path = archiveFile(w.workset, id);
    const archive = load(path);
    if (!archive) continue;
    for (const c of archive.comments.filter((x) => x.member === member.id && !x.resolved)) {
      for (const r of c.replies ?? []) {
        if (r.shown_in?.includes(sid)) continue;
        live ??= liveNotes(sid);
        const noteId = show(sid, c, r, live);
        if (noteId === null) continue;
        w.threads[noteId] = c.id; // the caller may hold w and save it whole
        recordThread(w.workset, sid, noteId, c.id);
        updateReviewFile(path, markShown(c.id, r, sid));
        for (const key of archive.sessions) updateReviewFile(inboxFile(key, id), markShown(c.id, r, sid));
      }
    }
  }
}
