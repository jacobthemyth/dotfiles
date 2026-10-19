import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import * as git from "./git";
import { removeInbox, removePidFile } from "./inbox";
import { sub } from "./paths";
import { clearNotes, loadLock } from "./review";
import { closeStale, listPointers, pointerState, type Pointer } from "./session";
import { removeFile } from "./store";
import { isNamed, memberStatuses, type MemberStatus, type TriageDeps } from "./triage";
import { deleteWorkset, listWorksets, loadWorkset, removeMember, saveWorkset, type Member, type Workset } from "./workset";

export type PrunePlan = {
  workset: string; refused: string | null;                    // "locked" when a lock exists
  members: { status: MemberStatus; cmds: string[] }[];        // prunable members; cmds is the git commands or [] for already-gone
  kept: MemberStatus[];                                       // not prunable, with reason
  rebase: { member: Member; from: string; to: string }[];     // base rewrites for remaining members
  deleteWorkset: boolean; keepReason: string | null;          // "members remain" | "open session <key>"
  pointers: { close: Pointer[]; delete: Pointer[] };          // stale → closed; closed-and-bound-only-here → deleted
};

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

// The git steps for one member. `done` holds worktree paths already scheduled or removed, so a path shared by
// several members is removed once; a branch that no longer exists is not deleted.
function steps(s: MemberStatus, done: Set<string>): { worktree: string | null; branch: string | null } {
  if (!s.repoExists) return { worktree: null, branch: null };
  let worktree: string | null = null;
  if (s.member.worktree && existsSync(s.member.worktree) && !done.has(real(s.member.worktree))) {
    worktree = s.member.worktree;
    done.add(real(worktree));
  }
  return { worktree, branch: s.branchExists ? s.member.branch : null };
}
const cmdsOf = (st: { worktree: string | null; branch: string | null }) => [
  ...(st.worktree ? [`git worktree remove ${st.worktree}`] : []),
  ...(st.branch ? [`git branch -D ${st.branch}`] : []),
];

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

export function planPrune(ws: Workset, deps: TriageDeps = {}): PrunePlan {
  const empty = { close: [], delete: [] };
  if (loadLock(ws.name)) {
    return { workset: ws.name, refused: "locked", members: [], kept: [], rebase: [], deleteWorkset: false, keepReason: null, pointers: empty };
  }
  const statuses = memberStatuses(ws, deps);
  const done = new Set<string>();
  const members = statuses.filter((s) => s.prunable).map((s) => ({ status: s, cmds: cmdsOf(steps(s, done)) }));
  const kept = statuses.filter((s) => !s.prunable);
  const pruned = members.map((m) => m.status.member);

  const rebase: PrunePlan["rebase"] = [];
  for (const r of kept) {
    const from = r.member.base;
    if (!from) continue;
    const p = pruned.find((x) => x.repo === r.member.repo && x.branch === from);
    if (!p) continue;
    let to = r.prBase ?? p.base ?? git.defaultBranch(r.member.repo);
    // a chain of pruned members collapses to the first base that survives
    for (let i = 0; i < pruned.length; i++) {
      const q = pruned.find((x) => x.repo === r.member.repo && x.branch === to);
      if (!q) break;
      to = q.base ?? git.defaultBranch(r.member.repo);
    }
    rebase.push({ member: r.member, from, to });
  }

  const ptr = pointerPlan(ws, deps.nowMs);
  let keepReason: string | null = null;
  if (kept.length > 0) keepReason = "members remain";
  else if (ptr.open) keepReason = `open session ${ptr.open.key}`;
  return { workset: ws.name, refused: null, members, kept, rebase, deleteWorkset: keepReason === null, keepReason, pointers: { close: ptr.close, delete: ptr.delete } };
}

// Runs only what the plan lists. Git failures are logged and skipped; a member whose git step failed stays in
// the workset, and the workset is then kept. Returns false if any git step failed or the plan was refused.
export function executePrune(plan: PrunePlan, log: (line: string) => void): boolean {
  if (plan.refused) { log(`refused: ${plan.refused}`); return false; }
  let ok = true;
  const failed = new Set<string>();   // member ids that stay
  const failedBranches = new Set<string>();
  const done = new Set<string>();
  for (const { status: s, cmds } of plan.members) {
    const st = steps(s, done);
    const run = (cmd: string, fn: () => boolean) => {
      if (!cmds.includes(cmd)) return; // only what the plan listed
      if (fn()) log(`ran in ${s.member.repo}: ${cmd}`);
      else { log(`failed in ${s.member.repo}: ${cmd}`); failed.add(s.member.id); failedBranches.add(s.member.branch); ok = false; }
    };
    if (st.worktree) run(`git worktree remove ${st.worktree}`, () => git.removeWorktree(s.member.repo, st.worktree!));
    if (st.branch && !failed.has(s.member.id)) run(`git branch -D ${st.branch}`, () => git.deleteBranch(s.member.repo, st.branch!));
  }

  const ws = loadWorkset(plan.workset);
  const removing = plan.members.filter((m) => !failed.has(m.status.member.id)).map((m) => m.status.member.id);
  if (ws) {
    for (const id of removing) removeMember(ws, id);
    if (!(plan.deleteWorkset && failed.size === 0)) {
      for (const r of plan.rebase) {
        if (failedBranches.has(r.from)) continue;
        const m = ws.members.find((x) => x.id === r.member.id);
        if (!m) continue;
        const viaPr = plan.kept.find((k) => k.member.id === m.id)?.prBase === r.to;
        m.base = r.to;
        if (viaPr) m.base_source = "pr";
        log(`rebased ${m.id}: ${r.from} -> ${r.to}`);
      }
      saveWorkset(ws);
    }
  }
  for (const p of plan.pointers.close) { closeStale(p); log(`closed stale pointer ${p.key}`); }
  if (plan.deleteWorkset && failed.size === 0) {
    for (const p of plan.pointers.delete) {
      removeInbox(p.key);
      removePidFile(p.key);
      removeFile(join(sub("sessions"), `${p.key}.json`));
      log(`deleted pointer ${p.key}`);
    }
    clearNotes(plan.workset);
    deleteWorkset(plan.workset);
    log("deleted workset");
  } else if (plan.deleteWorkset) {
    log("kept workset: a git step failed");
  }
  return ok;
}

// Default-named worksets that would be deleted outright: every member dead, nothing open, not locked.
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
  for (const k of plan.kept) out.push(`  kept ${k.member.id}: ${k.reason}`);
  for (const r of plan.rebase) out.push(`  rebase ${r.member.id}: ${r.from} -> ${r.to}`);
  out.push(plan.deleteWorkset ? "  delete workset" : `  keep workset: ${plan.keepReason}`);
  for (const p of plan.pointers.close) out.push(`  close stale pointer ${p.key}`);
  if (plan.deleteWorkset) for (const p of plan.pointers.delete) out.push(`  delete pointer ${p.key}`);
  return out.join("\n");
}
