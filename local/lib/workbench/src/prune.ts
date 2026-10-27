import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import * as git from "./git";
import { removeInbox, removePidFile, unreadCount } from "./inbox";
import { clearNotes, loadLock } from "./review";
import { windowOpen } from "./window";
import { closeStale, listPointers, loadPointer, pointerState, removePointer, type Pointer } from "./session";
import { boundKeys, memberStatuses, type MemberStatus, type TriageDeps } from "./triage";
import { deleteWorkset, listWorksets, loadWorkset, removeMember, saveWorkset, type Member, type Workset } from "./workset";

// Prune edits workset records and session pointers only. It never runs a git command: a dropped member's branch and
// worktree stay for `git cleanup`.
export type Rebase = { member: Member; from: string; to: string; viaPr: boolean };
export type PrunePlan = {
  workset: string; refused: string | null;                    // "review window open" | "locked" | "unread review" | "open session <key>"
  dropped: MemberStatus[];                                    // prunable records that leave the workset
  forgotten: MemberStatus[];                                  // not prunable, dropped anyway because the workset is deleted whole
  kept: MemberStatus[];                                       // records that stay, with reason
  rebase: Rebase[];                                           // base rewrites for kept members whose base is dropped
  deleteWorkset: boolean; keepReason: string | null;          // "members remain" | "open session <key>"
  pointers: { close: Pointer[]; delete: Pointer[] };          // stale → closed; closed-and-bound-only-here → deleted only when the workset is deleted
};

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const sameBranch = (a: { repo: string; branch: string }, b: { repo: string; branch: string }) =>
  a.branch === b.branch && real(a.repo) === real(b.repo);

function pointerPlan(ws: Workset, nowMs?: number): { close: Pointer[]; delete: Pointer[]; open: Pointer | null } {
  const others = listWorksets().filter((n) => n !== ws.name).map((n) => loadWorkset(n)).filter((w): w is Workset => !!w);
  const otherNames = new Set(others.map((w) => w.name));
  const mine = listPointers().filter((p) => p.workset === ws.name || ws.sessions.includes(p.key));
  const close: Pointer[] = [], del: Pointer[] = [];
  let open: Pointer | null = null;
  for (const p of mine) {
    const state = pointerState(p, nowMs);
    if (state === "open") { open ??= p; continue; }
    if (state === "stale") close.push(p);
    const shared = (p.workset !== null && otherNames.has(p.workset)) || others.some((w) => w.sessions.includes(p.key));
    if (!shared) del.push(p);
  }
  return { close, delete: del, open };
}

// The new base for a kept member whose base `from` is a dropped branch: its PR's base, else the dropped member's
// own base, else the default branch; a chain of dropped members collapses to the first base that survives.
function newBase(repo: string, from: string, prBase: string | null, dropped: Member[]): string | null {
  const p = dropped.find((x) => sameBranch(x, { repo, branch: from }));
  if (!p) return null;
  let to = prBase ?? p.base ?? git.defaultBranch(repo);
  for (let i = 0; i < dropped.length; i++) {
    const q = dropped.find((x) => sameBranch(x, { repo, branch: to }));
    if (!q) break;
    to = q.base ?? git.defaultBranch(repo);
  }
  return to;
}

// The window file and tmux session are keyed by the workset's name: quit the window before changing the record.
export const WINDOW_OPEN = "review window open";
const refusedPlan = (ws: Workset, refused: string): PrunePlan =>
  ({ workset: ws.name, refused, dropped: [], forgotten: [], kept: [], rebase: [], deleteWorkset: false, keepReason: null, pointers: { close: [], delete: [] } });

// `all` forgets the workset whole whatever its members hold (the `delete` command); an open session then
// refuses the plan instead of keeping the workset.
export function planPrune(ws: Workset, deps: TriageDeps = {}, { all = false } = {}): PrunePlan {
  if (windowOpen(ws.name)) return refusedPlan(ws, WINDOW_OPEN);
  if (loadLock(ws.name)) return refusedPlan(ws, "locked");
  if (boundKeys(ws).some((k) => unreadCount(k) > 0)) return refusedPlan(ws, "unread review");
  const ptr = pointerPlan(ws, deps.nowMs);
  if (all && ptr.open) return refusedPlan(ws, `open session ${ptr.open.key}`);
  const statuses = memberStatuses(ws, deps);
  const dropped = statuses.filter((s) => s.prunable);
  const rest = statuses.filter((s) => !s.prunable);
  // Only prunable records leave; the workset itself goes once nothing remains and no session is open on it.
  const forgotten = all ? rest : [];
  const kept = all ? [] : rest;

  const rebase: Rebase[] = [];
  const droppedMembers = dropped.map((s) => s.member);
  for (const r of kept) {
    const from = r.member.base;
    if (!from) continue;
    const to = newBase(r.member.repo, from, r.prBase, droppedMembers);
    if (to !== null) rebase.push({ member: r.member, from, to, viaPr: r.prBase !== null && to === r.prBase });
  }

  const openSession = ptr.open ? `open session ${ptr.open.key}` : null;
  const keepReason = all ? null : kept.length > 0 ? "members remain" : openSession;
  return {
    workset: ws.name, refused: null, dropped, forgotten, kept, rebase,
    deleteWorkset: keepReason === null, keepReason, pointers: { close: ptr.close, delete: ptr.delete },
  };
}

function applyRebase(ws: Workset, rebase: Rebase[], log: (line: string) => void): void {
  for (const r of rebase) {
    const m = ws.members.find((x) => x.id === r.member.id);
    if (!m) continue;
    m.base = r.to;
    if (r.viaPr) m.base_source = "pr";
    log(`rebased ${m.id}: ${r.from} -> ${r.to}`);
  }
}

// Runs only what the plan lists. Returns false only when the plan was refused.
export function executePrune(plan: PrunePlan, log: (line: string) => void): boolean {
  if (plan.refused) { log(`refused: ${plan.refused}`); return false; }
  const ws = loadWorkset(plan.workset);
  // Re-read state the plan only sampled: the workset may have gained members, a session may have come back.
  const openNow = (p: Pointer) => { const f = loadPointer(p.key); return !!f && pointerState(f) === "open"; };
  const reviving = [...plan.pointers.close, ...plan.pointers.delete].some(openNow);
  const planned = new Set([...plan.dropped, ...plan.forgotten].map((s) => s.member.id));
  const membersLeft = ws ? ws.members.filter((m) => !planned.has(m.id)).length : 0;
  const deleting = plan.deleteWorkset && !reviving && membersLeft === 0;
  if (ws) {
    for (const s of plan.dropped) { removeMember(ws, s.member.id); log(`dropped ${s.member.id}: ${s.reason}`); }
    if (deleting) for (const s of plan.forgotten) { removeMember(ws, s.member.id); log(`forgot ${s.member.id}: ${s.reason}`); }
    else { applyRebase(ws, plan.rebase, log); saveWorkset(ws); }
  }
  for (const p of plan.pointers.close) {
    const f = loadPointer(p.key);
    if (!f || pointerState(f) !== "stale") continue;
    closeStale(f);
    log(`closed stale pointer ${p.key}`);
  }
  if (deleting) {
    for (const p of plan.pointers.delete) {
      if (!p.key || p.key.includes("/")) { log(`skipped pointer with unsafe key "${p.key}"`); continue; }
      removeInbox(p.key);
      removePidFile(p.key);
      removePointer(p.key);
      log(`deleted pointer ${p.key}`);
    }
    clearNotes(plan.workset);
    deleteWorkset(plan.workset);
    log("deleted workset");
  } else if (plan.deleteWorkset) {
    log(reviving ? "kept workset: open session" : "kept workset: members remain");
  }
  return true;
}

export const planDelete = (ws: Workset, deps: TriageDeps = {}) => planPrune(ws, deps, { all: true });

// Every workset whose prune would do something: drop a record or delete the workset. Refusals and no-ops are left out.
export function pruneAll(deps: TriageDeps = {}): PrunePlan[] {
  const out: PrunePlan[] = [];
  for (const name of listWorksets()) {
    const ws = loadWorkset(name);
    if (!ws) continue;
    const plan = planPrune(ws, deps);
    // A windowed workset is listed, refused, so the run says why it was skipped.
    if (plan.refused === WINDOW_OPEN || (!plan.refused && (plan.dropped.length > 0 || plan.deleteWorkset))) out.push(plan);
  }
  return out;
}

// Repos whose branches a prune leaves behind for `git cleanup`.
const leftBehind = (plan: PrunePlan) => [...new Set([...plan.dropped, ...plan.forgotten].filter((s) => s.branchExists).map((s) => s.member.repo))];

export function renderPlan(plan: PrunePlan): string {
  const out = [`${plan.workset}:`];
  if (plan.refused) { out.push(`  refused: ${plan.refused}`); return out.join("\n"); }
  for (const s of plan.dropped) out.push(`  drop ${s.member.id}: ${s.reason}`);
  for (const s of plan.forgotten) out.push(`  forget ${s.member.id}: ${s.reason}`);
  // A kept member's reason names an open PR or a dirty tree itself; unpushed commits it would not.
  for (const k of plan.kept) out.push(`  kept ${k.member.id}: ${k.reason}${k.unpushed ? ", unpushed" : ""}`);
  for (const r of plan.rebase) out.push(`  rebase ${r.member.id}: ${r.from} -> ${r.to}`);
  out.push(plan.deleteWorkset ? "  delete workset" : `  keep workset: ${plan.keepReason}`);
  for (const p of plan.pointers.close) out.push(`  close stale pointer ${p.key}`);
  if (plan.deleteWorkset) for (const p of plan.pointers.delete) out.push(`  delete pointer ${p.key}`);
  for (const repo of leftBehind(plan)) out.push(`  branches left for git cleanup in ${repo}`);
  return out.join("\n");
}
