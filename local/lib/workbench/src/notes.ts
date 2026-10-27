import { threadedUserReplies, type ThreadedReply } from "./comments";
import * as hunk from "./hunk";
import { loadNotes, saveNotes } from "./review";
import { hunkTarget, loadWindow, type Window } from "./window";
import { writeJson } from "./store";
import { windowFile } from "./window";
import type { Member } from "./workset";

export type SyncResult = { notes: hunk.RawNote[]; replies: ThreadedReply[]; deleted: string[]; warnings: string[] };

// A note id live at the previous sync and gone now was deleted in hunk: it leaves the snapshot, and a deleted
// proxy (a `you:` copy re-shown after a hunk restart) takes its original with it.
export function applyDeletions(saved: hunk.RawNote[], prevLive: Record<string, string | null>, nowIds: Set<string>): { notes: hunk.RawNote[]; deleted: string[] } {
  const gone = new Set<string>();
  for (const [id, original] of Object.entries(prevLive)) if (!nowIds.has(id)) gone.add(original ?? id);
  const notes = saved.filter((n) => !gone.has(n.noteId));
  return { notes, deleted: saved.filter((n) => gone.has(n.noteId)).map((n) => n.noteId) };
}

const ownTopLevel = (n: hunk.RawNote) => n.source === "user" && !n.parentId;

// Writes w.live[memberId] into the window file as it is on disk now, so a concurrent writer's other fields survive.
// Skipped when the file has moved to another hunk session: this live set describes the old one.
function persistLive(w: Window, memberId: string): void {
  const fresh = loadWindow(w.workset);
  if (!fresh || fresh.hunkSessionId !== w.hunkSessionId) return;
  fresh.live = { ...fresh.live, [memberId]: w.live[memberId] ?? {} };
  writeJson(windowFile(w.workset), fresh);
}

export function recordProxy(w: Window, memberId: string, proxyId: string, originalId: string): void {
  w.live[memberId] = { ...(w.live[memberId] ?? {}), [proxyId]: originalId };
  persistLive(w, memberId);
}

// Snapshots `m`'s notes from the live hunk session: deletions since the last sync leave the snapshot, notes on
// screen are merged in by id, and the live set is rebuilt. When hunk cannot be listed nothing is deleted.
export function syncMember(w: Window, m: Member): SyncResult {
  const saved = loadNotes(w.workset, m.id);
  const all = hunk.listNotes(hunkTarget(w, m));
  if (all === null) { saveNotes(w.workset, m.id, saved); return { notes: saved, replies: [], deleted: [], warnings: [] }; }
  const nowIds = new Set(all.map((n) => n.noteId));
  const prev = w.live[m.id] ?? {};
  const { notes, deleted } = applyDeletions(saved, prev, nowIds);
  const merged = new Map(notes.map((n) => [n.noteId, n]));
  for (const n of all.filter(ownTopLevel)) merged.set(n.noteId, n);
  const out = [...merged.values()];
  saveNotes(w.workset, m.id, out);
  const live: Record<string, string | null> = {};
  for (const n of all.filter(ownTopLevel)) live[n.noteId] = null;
  for (const [id, original] of Object.entries(prev)) if (original !== null && nowIds.has(id) && merged.has(original)) live[id] = original;
  w.live[m.id] = live;
  persistLive(w, m.id);
  return { notes: out, replies: threadedUserReplies(all), deleted, warnings: [] };
}
