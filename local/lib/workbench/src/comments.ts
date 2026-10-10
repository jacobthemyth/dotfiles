// Pure: hunk user notes to typed, anchored comments.
export type Reply = { at: string; by: string; text: string; shown_in?: string[] };
export type CommentType = "change" | "question" | "note";
export type Comment = {
  id: string; member: string; repo: string; slug: string | null; branch: string; path: string;
  line: { side: "new" | "old"; start: number; end: number }; sha: string; type: CommentType; text: string; replies: Reply[];
};
export type Anchor = Pick<Comment, "member" | "repo" | "slug" | "branch" | "sha">;

// `?` question, `//` note, anything else a change request.
export function parseSigil(text: string): { type: CommentType; text: string } {
  const t = text.trim();
  if (t.startsWith("?")) return { type: "question", text: t.slice(1).trim() };
  if (t.startsWith("//")) return { type: "note", text: t.slice(2).trim() };
  return { type: "change", text: t };
}

type Note = { noteId?: unknown; source?: unknown; parentId?: unknown; filePath?: unknown; body?: unknown; newRange?: unknown; oldRange?: unknown };
const range = (r: unknown): [number, number] | null =>
  Array.isArray(r) && r.length === 2 && r.every((n) => typeof n === "number") ? [r[0], r[1]] : null;
const NO_ANCHOR: Anchor = { member: "", repo: "", slug: null, branch: "", sha: "" };

// Accepts the `comment list --json` object or its `comments` array. Keeps top-level user notes only.
export function normaliseNotes(raw: unknown, anchor: Anchor = NO_ANCHOR): Comment[] {
  const list = Array.isArray(raw) ? raw : (raw as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list)) return [];
  const out: Comment[] = [];
  for (const n of list as Note[]) {
    if (!n || n.source !== "user" || n.parentId || typeof n.noteId !== "string" || typeof n.filePath !== "string") continue;
    const nw = range(n.newRange), old = range(n.oldRange);
    const [side, [start, end]] = nw ? ["new" as const, nw] : old ? ["old" as const, old] : ["new" as const, [0, 0]];
    out.push({ id: n.noteId, ...anchor, path: n.filePath, line: { side, start, end }, ...parseSigil(String(n.body ?? "")), replies: [] });
  }
  return out;
}
