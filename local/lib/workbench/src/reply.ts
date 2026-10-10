import { join } from "node:path";
import type { Comment, Reply } from "./comments";
import * as hunk from "./hunk";
import { sub } from "./paths";
import { archiveFile, loadReview, type Review } from "./review";
import { listJson, now, readJson, writeJson } from "./store";
import { inboxFile, type ReviewFile } from "./submit";
import type { Member } from "./workset";

type Copy = { path: string; file: ReviewFile };
const load = (path: string): Copy | null => {
  try { const file = readJson<ReviewFile>(path); return file ? { path, file } : null; } catch { return null; }
};
const sameReply = (a: Reply, b: Reply) => a.at === b.at && a.by === b.by && a.text === b.text;

// Shows one reply in a live hunk session: threaded under the user's note while it is still live there,
// else as an agent comment on the comment's line. `live` holds the session's note ids.
function show(sessionId: string, c: Comment, r: Reply, live: Set<string>): boolean {
  const t: hunk.Target = { id: sessionId, path: "" };
  const summary = `↩ ${r.text}`;
  if (live.has(c.id)) return hunk.addAgentComment(t, { replyTo: c.id, summary, author: r.by });
  const line = c.line.side === "old" ? { oldLine: c.line.start } : { newLine: c.line.start };
  return hunk.addAgentComment(t, { file: c.path, ...line, summary, rationale: `re: ${c.text}`, author: r.by });
}
const liveNotes = (sessionId: string) => new Set(hunk.allNotes({ id: sessionId, path: "" }).map((n) => n.noteId));

// Appends the reply to the session's inbox copy and the archive, showing it first when the review window
// has the comment's member open in a live hunk session, so both copies carry the same shown_in.
export function addReply(sessionKey: string, reviewId: string, commentId: string, text: string): { reply: Reply; shown: boolean } {
  const mine = load(inboxFile(sessionKey, reviewId));
  if (!mine) throw new Error(`workbench: no review "${reviewId}" in ${sessionKey}`);
  const c = mine.file.comments.find((x) => x.id === commentId);
  if (!c) throw new Error(`workbench: no comment "${commentId}" in review ${reviewId}`);

  const reply: Reply = { at: now(), by: sessionKey, text };
  const open = loadReview(mine.file.workset);
  const sid = open?.current === c.member ? open.hunkSessionId : null;
  const shown = !!sid && hunk.hasSession(sid) && show(sid, c, reply, liveNotes(sid));
  if (shown) reply.shown_in = [sid!];

  const archive = load(archiveFile(mine.file.workset, reviewId));
  for (const copy of [mine, archive]) {
    const target = copy?.file.comments.find((x) => x.id === commentId);
    if (!copy || !target) continue;
    target.replies = [...(target.replies ?? []), { ...reply }];
    writeJson(copy.path, copy.file); // the inbox copy keeps its read flag: the whole file round-trips
  }
  return { reply, shown };
}

// Shows, in the review's current hunk session, every archived reply to this member's comments that the
// session has not shown yet, and records the session in shown_in on the archive and each inbox copy.
export function rehydrateReplies(review: Review, member: Member): void {
  const sid = review.hunkSessionId;
  if (!sid) return;
  let live: Set<string> | null = null;
  for (const id of listJson(join(sub("reviews"), review.workset))) {
    const archive = load(archiveFile(review.workset, id));
    if (!archive) continue;
    const shownNow: { comment: string; reply: Reply }[] = [];
    for (const c of archive.file.comments.filter((x) => x.member === member.id)) {
      for (const r of c.replies ?? []) {
        if (r.shown_in?.includes(sid)) continue;
        live ??= liveNotes(sid);
        if (!show(sid, c, r, live)) continue;
        shownNow.push({ comment: c.id, reply: { ...r } });
        r.shown_in = [...(r.shown_in ?? []), sid];
      }
    }
    if (shownNow.length === 0) continue;
    writeJson(archive.path, archive.file);
    for (const key of archive.file.sessions) {
      const copy = load(inboxFile(key, id));
      if (!copy) continue;
      let changed = false;
      for (const { comment, reply } of shownNow) {
        const r = copy.file.comments.find((x) => x.id === comment)?.replies?.find((x) => sameReply(x, reply));
        if (r && !r.shown_in?.includes(sid)) { r.shown_in = [...(r.shown_in ?? []), sid]; changed = true; }
      }
      if (changed) writeJson(copy.path, copy.file);
    }
  }
}
