import type { Config } from "./config";
import type { Pointer } from "./session";
import { diffBase, orderMembers, stackNodes, type StackNode } from "./stack";
import type { Member, Workset } from "./workset";

export type Row =
  | { kind: "header"; text: string }
  | { kind: "member"; text: string; member: Member }
  | { kind: "stack"; text: string; node: StackNode }
  | { kind: "session"; text: string };

export const KEYS = "j/k move  ⏎ show  t throwaways  r review  s submit  c close (asks for yes)  q quit";
export const STATUS = { alreadyOpen: "a review is already open", nothingToSubmit: "no review to submit; press r", nothingToClose: "nothing to close" } as const;
// The window is watching with no review open, reviewing with one.
export const headerLine = (name: string, reviewId: string | null): string => (reviewId ? `${name}  reviewing ${reviewId}` : `${name}  watching`);

// A bound session and the inbox reviews it holds (only the fields the session line counts).
export type SessionView = { pointer: Pointer; reviews: { read: boolean; comments: { replies?: unknown[] }[] }[] };
export type View = { showThrowaway: boolean; sessions: SessionView[]; current: string | null };

// `<key>  open|closed  inbox: <unread> unread  replies <answered>/<comments>`
export function sessionLine(s: SessionView): string {
  const unread = s.reviews.filter((r) => !r.read).length;
  const comments = s.reviews.flatMap((r) => r.comments);
  const answered = comments.filter((c) => (c.replies?.length ?? 0) > 0).length;
  return `${s.pointer.key}  ${s.pointer.closed ? "closed" : "open"}  inbox: ${unread} unread  replies ${answered}/${comments.length}`;
}

export function prLabel(pr: Member["pr"]): string {
  if (!pr) return "-";
  return `PR #${pr.number} ${pr.draft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`;
}

export function buildRows(ws: Workset, config: Config, view: View): Row[] {
  const members = orderMembers(ws.members).filter((m) => view.showThrowaway || m.role === "work");
  const rows: Row[] = [{ kind: "header", text: "members" }];
  for (const m of members) {
    const mark = m.id === view.current ? "*" : " ";
    rows.push({ kind: "member", member: m, text: `${mark}[${m.role}] ${m.id}  ${prLabel(m.pr)}  (${diffBase(m, config)} → ${m.branch})` });
  }
  for (const node of stackNodes(members, config)) {
    const mark = node.top.id === view.current ? "*" : " ";
    rows.push({ kind: "stack", node, text: `${mark}whole stack ${node.slug ?? node.repo}  (${node.bottomBase} → ${node.top.branch})` });
  }
  rows.push({ kind: "header", text: "sessions" });
  for (const s of view.sessions) rows.push({ kind: "session", text: `  ${sessionLine(s)}` });
  return rows;
}

const selectable = (r: Row) => r.kind === "member" || r.kind === "stack";

// Moves the selection by delta among selectable rows, wrapping at both ends. -1 when none is selectable.
export function move(rows: Row[], sel: number, delta: number): number {
  const idx = rows.flatMap((r, i) => (selectable(r) ? [i] : []));
  if (idx.length === 0) return -1;
  const at = idx.indexOf(sel);
  if (at === -1) return idx.find((i) => i >= sel) ?? idx[idx.length - 1];
  return idx[(((at + delta) % idx.length) + idx.length) % idx.length];
}

// Keeps a selection valid after the rows changed: same index if still selectable, else the next one.
export const clamp = (rows: Row[], sel: number) => move(rows, sel, 0);

// The first visible row so that sel stays inside a window of `height` rows.
export function scroll(top: number, sel: number, height: number): number {
  if (sel < 0) return 0;
  if (sel < top) return sel;
  if (sel >= top + height) return sel - height + 1;
  return top;
}

// Splits terminal input into keys: plain characters and the arrow keys (as `\x1b[A`..`\x1b[D`). Every other escape
// sequence is dropped whole. hunk queries the outer terminal's palette through tmux passthrough, and tmux hands the
// reply (`\x1b]11;rgb:1c1c/…\x1b\\`) to the active pane, the sidebar; read char by char, its `c` would close the review.
// rest is an escape sequence cut off at the end of buf: prepend it to the next chunk.
const SEQ = /\x1b(?:\[([0-?]*[ -/]*[@-~])|O([@-~])|[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|[^\]P_^X\[O])|[^\x1b]/y;
export function splitKeys(buf: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  let at = 0;
  for (let m: RegExpExecArray | null; (SEQ.lastIndex = at), (m = SEQ.exec(buf)); at = SEQ.lastIndex) {
    const final = m[1] ?? m[2];
    if (m[0][0] !== "\x1b") keys.push(m[0]);
    else if (final && /^[A-D]$/.test(final)) keys.push(`\x1b[${final}`);
  }
  // A lone Esc keypress is not the start of a reply; a runaway fragment is not worth holding.
  const rest = buf.slice(at);
  return { keys, rest: rest === "\x1b" || rest.length > 256 ? "" : rest };
}
