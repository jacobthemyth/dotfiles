import type { Config } from "./config";
import { foundId, type Found } from "./derive";
import type { Pointer } from "./session";
import { diffBase, orderMembers, stackNodes, type StackNode } from "./stack";
import type { Member, Workset } from "./workset";

export type Row =
  | { kind: "header"; text: string }
  | { kind: "member"; text: string; member: Member }
  | { kind: "stack"; text: string; node: StackNode }
  | { kind: "unclaimed"; text: string; found: Found }
  | { kind: "session"; text: string };

export type View = { showThrowaway: boolean; unclaimed: Found[] | null; sessions: Pointer[]; current: string | null };

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
  rows.push({ kind: "header", text: view.unclaimed ? `unclaimed (${view.unclaimed.length})` : "unclaimed (scanning…)" });
  for (const f of view.unclaimed ?? []) rows.push({ kind: "unclaimed", found: f, text: `  ${foundId(f)}  ${prLabel(f.pr)}` });
  rows.push({ kind: "header", text: "sessions" });
  for (const p of view.sessions) rows.push({ kind: "session", text: `  ${p.key}  ${p.closed ? "closed" : "open"}` });
  return rows;
}

const selectable = (r: Row) => r.kind === "member" || r.kind === "stack" || r.kind === "unclaimed";

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
