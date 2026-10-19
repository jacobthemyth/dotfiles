import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import * as gh from "./gh";
import * as git from "./git";
import { removeInbox, removePidFile, unreadCount } from "./inbox";
import { clearNotes, loadLock } from "./review";
import { closeStale, listPointers, loadPointer, pointerState, removePointer, type Pointer } from "./session";
import { boundKeys, isNamed, memberStatuses, type MemberStatus, type TriageDeps } from "./triage";
import { deleteWorkset, listWorksets, loadWorkset, removeMember, saveWorkset, type Member, type Workset } from "./workset";

export type Steps = { worktree: string | null; branch: string | null; sha: string | null };
export type Rebase = { member: Member; from: string; to: string; viaPr: boolean };
// Another workset of the same checkout that lists a pruned member: the member leaves it and its bases are re-pointed,
// unless it holds a review lock, in which case it is left untouched.
export type SiblingPlan = { workset: string; locked: boolean; remove: Member[]; rebase: Rebase[] };
export type PrunePlan = {
  workset: string; refused: string | null;                    // "locked" | "unread review"
  members: { status: MemberStatus; steps: Steps; cmds: string[] }[]; // prunable members; cmds is [] for already-gone
  kept: MemberStatus[];                                       // not prunable, with reason
  rebase: Rebase[];                                           // base rewrites for remaining members
  siblings: SiblingPlan[];
  deleteWorkset: boolean; keepReason: string | null;          // "members remain" | "open session <key>"
  pointers: { close: Pointer[]; delete: Pointer[] };          // stale → closed; closed-and-bound-only-here → deleted only when the workset is deleted
};

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const sameBranch = (a: { repo: string; branch: string }, b: { repo: string; branch: string }) =>
  a.branch === b.branch && real(a.repo) === real(b.repo);

// The git steps for one member: the worktree git has its branch checked out in (never the main checkout), then the
// branch at its planned tip. `done` holds worktree paths already scheduled, so a path is removed once.
function steps(s: MemberStatus, done: Set<string>): Steps {
  if (!s.repoExists) return { worktree: null, branch: null, sha: null };
  let worktree: string | null = null;
  if (s.realWorktree && !s.mainCheckout && !done.has(real(s.realWorktree))) {
    worktree = s.realWorktree;
    done.add(real(worktree));
  }
  return s.branchExists && s.tip ? { worktree, branch: s.member.branch, sha: s.tip } : { worktree, branch: null, sha: null };
}
const worktreeCmd = (st: Steps) => `git worktree remove ${st.worktree}`;
const branchCmd = (st: Steps) => `git update-ref -d refs/heads/${st.branch} ${st.sha}`;
const cmdsOf = (st: Steps) => [...(st.worktree ? [worktreeCmd(st)] : []), ...(st.branch ? [branchCmd(st)] : [])];

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
    const shared = otherNames.has(p.workset) || others.some((w) => w.sessions.includes(p.key));
    if (!shared) del.push(p);
  }
  return { close, delete: del, open };
}

// The new base for a remaining member whose base `from` was a pruned branch: its PR's base, else the pruned
// member's own base, else the default branch; a chain of pruned members collapses to the first base that survives.
function newBase(repo: string, from: string, prBase: string | null, pruned: Member[]): string | null {
  const p = pruned.find((x) => sameBranch(x, { repo, branch: from }));
  if (!p) return null;
  let to = prBase ?? p.base ?? git.defaultBranch(repo);
  for (let i = 0; i < pruned.length; i++) {
    const q = pruned.find((x) => sameBranch(x, { repo, branch: to }));
    if (!q) break;
    to = q.base ?? git.defaultBranch(repo);
  }
  return to;
}

function siblingPlans(ws: Workset, pruned: Member[], deps: TriageDeps): SiblingPlan[] {
  const prs = deps.prs ?? gh.prsForBranches;
  const out: SiblingPlan[] = [];
  for (const name of listWorksets()) {
    if (name === ws.name) continue;
    const other = loadWorkset(name);
    if (!other) continue;
    const remove = other.members.filter((m) => pruned.some((p) => sameBranch(p, m)));
    if (remove.length === 0) continue;
    if (loadLock(name)) { out.push({ workset: name, locked: true, remove, rebase: [] }); continue; }
    const needing = other.members.filter((m) => !remove.includes(m) && m.base && pruned.some((p) => sameBranch(p, { repo: m.repo, branch: m.base! })));
    const bySlug = new Map<string, string[]>();
    for (const m of needing) if (m.slug) bySlug.set(m.slug, [...(bySlug.get(m.slug) ?? []), m.branch]);
    const found = new Map<string, Map<string, gh.BranchPr>>();
    for (const [slug, branches] of bySlug) {
      const result = prs(slug, [...new Set(branches)]);
      if (!gh.lastGhError) found.set(slug, result);
    }
    const rebase: Rebase[] = [];
    for (const m of needing) {
      const prBase = (m.slug ? found.get(m.slug)?.get(m.branch)?.base : undefined) ?? null;
      const to = newBase(m.repo, m.base!, prBase, pruned);
      if (to !== null) rebase.push({ member: m, from: m.base!, to, viaPr: prBase !== null && to === prBase });
    }
    out.push({ workset: name, locked: false, remove, rebase });
  }
  return out;
}

const refusedPlan = (ws: Workset, refused: string): PrunePlan =>
  ({ workset: ws.name, refused, members: [], kept: [], rebase: [], siblings: [], deleteWorkset: false, keepReason: null, pointers: { close: [], delete: [] } });

export function planPrune(ws: Workset, deps: TriageDeps = {}): PrunePlan {
  if (loadLock(ws.name)) return refusedPlan(ws, "locked");
  if (boundKeys(ws).some((k) => unreadCount(k) > 0)) return refusedPlan(ws, "unread review");
  const statuses = memberStatuses(ws, deps);
  const done = new Set<string>();
  const members = statuses.filter((s) => s.prunable).map((s) => { const st = steps(s, done); return { status: s, steps: st, cmds: cmdsOf(st) }; });
  const kept = statuses.filter((s) => !s.prunable);
  // A pruned member's branch is deleted by this prune or already absent, so its record goes everywhere it is listed.
  const pruned = members.filter((m) => m.steps.branch !== null || !m.status.branchExists).map((m) => m.status.member);

  const rebase: Rebase[] = [];
  for (const r of kept) {
    const from = r.member.base;
    if (!from) continue;
    const to = newBase(r.member.repo, from, r.prBase, pruned);
    if (to !== null) rebase.push({ member: r.member, from, to, viaPr: r.prBase !== null && to === r.prBase });
  }

  const ptr = pointerPlan(ws, deps.nowMs);
  let keepReason: string | null = null;
  if (kept.length > 0) keepReason = "members remain";
  else if (ptr.open) keepReason = `open session ${ptr.open.key}`;
  return {
    workset: ws.name, refused: null, members, kept, rebase, siblings: siblingPlans(ws, pruned, deps),
    deleteWorkset: keepReason === null, keepReason, pointers: { close: ptr.close, delete: ptr.delete },
  };
}

function applyRebase(ws: Workset, rebase: Rebase[], failed: (r: Rebase) => boolean, log: (line: string) => void, where = ""): void {
  for (const r of rebase) {
    if (failed(r)) continue;
    const m = ws.members.find((x) => x.id === r.member.id);
    if (!m) continue;
    m.base = r.to;
    if (r.viaPr) m.base_source = "pr";
    log(`rebased ${m.id}${where}: ${r.from} -> ${r.to}`);
  }
}

// Runs only what the plan lists. Git failures are logged and skipped; a member whose git step failed stays in
// the workset, and the workset is then kept. Returns false if any git step failed or the plan was refused.
export function executePrune(plan: PrunePlan, log: (line: string) => void): boolean {
  if (plan.refused) { log(`refused: ${plan.refused}`); return false; }
  let ok = true;
  const failed = new Set<string>();   // member ids that stay
  const failedMembers: Member[] = [];
  for (const { status: s, steps: st } of plan.members) {
    const run = (cmd: string, fn: () => boolean) => {
      if (fn()) log(`ran in ${s.member.repo}: ${cmd}`);
      else { log(`failed in ${s.member.repo}: ${cmd}`); failed.add(s.member.id); failedMembers.push(s.member); ok = false; }
    };
    // The worktree is removed only while it still has the member's branch checked out.
    if (st.worktree) run(worktreeCmd(st), () => git.currentBranch(st.worktree!) === st.branch && git.removeWorktree(s.member.repo, st.worktree!));
    if (st.branch && !failed.has(s.member.id)) run(branchCmd(st), () => git.deleteBranchAt(s.member.repo, st.branch!, st.sha!));
  }
  const failedFrom = (r: Rebase) => failedMembers.some((f) => sameBranch(f, { repo: r.member.repo, branch: r.from }));

  const ws = loadWorkset(plan.workset);
  const removing = plan.members.filter((m) => !failed.has(m.status.member.id)).map((m) => m.status.member.id);
  // Re-read state the plan only sampled: the workset may have gained members, a session may have come back.
  const openNow = (p: Pointer) => { const f = loadPointer(p.key); return !!f && pointerState(f) === "open"; };
  const reviving = [...plan.pointers.close, ...plan.pointers.delete].some(openNow);
  const membersLeft = ws ? ws.members.filter((m) => !removing.includes(m.id)).length : 0;
  const deleting = plan.deleteWorkset && failed.size === 0 && !reviving && membersLeft === 0;
  if (ws) {
    for (const id of removing) removeMember(ws, id);
    if (!deleting) { applyRebase(ws, plan.rebase, failedFrom, log); saveWorkset(ws); }
  }
  const pruned = plan.members.filter((m) => !failed.has(m.status.member.id)).map((m) => m.status.member);
  for (const sib of plan.siblings) {
    if (sib.locked || loadLock(sib.workset)) { log(`sibling ${sib.workset} locked; not updated`); continue; }
    const other = loadWorkset(sib.workset);
    if (!other) continue;
    const gone = other.members.filter((m) => pruned.some((p) => sameBranch(p, m)));
    for (const m of gone) { removeMember(other, m.id); log(`removed ${m.id} from workset ${sib.workset}`); }
    applyRebase(other, sib.rebase, failedFrom, log, ` in ${sib.workset}`);
    saveWorkset(other);
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
    log(failed.size > 0 ? "kept workset: a git step failed" : reviving ? "kept workset: open session" : "kept workset: members remain");
  }
  return ok;
}

// Default-named worksets that would be deleted outright: every member dead, nothing open, not locked or unread.
export function sweepable(deps: TriageDeps = {}): PrunePlan[] {
  const out: PrunePlan[] = [];
  for (const name of listWorksets()) {
    const ws = loadWorkset(name);
    if (!ws || isNamed(ws.name)) continue;
    const plan = planPrune(ws, deps);
    if (!plan.refused && plan.deleteWorkset) out.push(plan);
  }
  return out;
}

export function renderPlan(plan: PrunePlan): string {
  const out = [`${plan.workset}:`];
  if (plan.refused) { out.push(`  refused: ${plan.refused}`); return out.join("\n"); }
  for (const m of plan.members) {
    if (m.cmds.length === 0) out.push(`  nothing to run for ${m.status.member.id}: ${m.status.reason}`);
    for (const c of m.cmds) out.push(`  would run in ${m.status.member.repo}: ${c}`);
  }
  for (const s of plan.siblings) {
    if (s.locked) { out.push(`  sibling ${s.workset} locked; not updated`); continue; }
    out.push(`  also removes from workset ${s.workset}`);
    for (const r of s.rebase) out.push(`  also rebases ${r.member.id} in ${s.workset}: ${r.from} -> ${r.to}`);
  }
  for (const k of plan.kept) out.push(`  kept ${k.member.id}: ${k.reason}`);
  for (const r of plan.rebase) out.push(`  rebase ${r.member.id}: ${r.from} -> ${r.to}`);
  out.push(plan.deleteWorkset ? "  delete workset" : `  keep workset: ${plan.keepReason}`);
  for (const p of plan.pointers.close) out.push(`  close stale pointer ${p.key}`);
  if (plan.deleteWorkset) for (const p of plan.pointers.delete) out.push(`  delete pointer ${p.key}`);
  return out.join("\n");
}
