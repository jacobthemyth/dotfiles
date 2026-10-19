import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as gh from "./gh";
import * as git from "./git";
import { loadConfig, type Config } from "./config";
import { unreadCount } from "./inbox";
import { loadLock } from "./review";
import { listPointers, pointerState, type Pointer } from "./session";
import { diffBase } from "./stack";
import { transcriptPath } from "./harness/claude";
import { listWorksets, loadWorkset, type Member, type Pr, type Workset } from "./workset";

export type PrState = "merged" | "closed" | "open" | "nopr";
export type MemberStatus = {
  member: Member; pr: PrState; prNumber: number | null; prBase: string | null;
  headRefOid: string | null; // PR head commit from a successful lookup; null otherwise
  prRecord: Pr | null;       // the looked-up PR, for refreshStoredPr; null when nothing was looked up
  branchExists: boolean; repoExists: boolean; worktreeExists: boolean;
  dirty: number;
  unpushed: boolean;
  cwdOf: string | null;
  worktreeHead: string | null; // branch checked out in the member's worktree; null when detached or no worktree
  prunable: boolean; reason: string;
};
export type Action = "review" | "prune" | "name" | "-";
export type WorksetSummary = {
  name: string; named: boolean; members: MemberStatus[];
  prMix: Record<PrState, number>; dirty: number;
  sessions: { open: number; stale: number; closed: number; last: string | null };
  action: Action;
};
export const isNamed = (name: string) => !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name);
export type TriageDeps = { prs?: typeof gh.prsForBranches; nowMs?: number };

const STORED: Record<string, PrState> = { MERGED: "merged", CLOSED: "closed", OPEN: "open" };
const storedState = (m: Member): PrState => (m.pr ? STORED[m.pr.state] ?? "nopr" : "nopr");
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

function configOrDefault(): Config {
  try { return loadConfig(); } catch {
    return { repo_roots: [], worktree_dirs: [], exclude_repos: [], github_user: "@me", harnesses: ["claude"], default_branch: "main" };
  }
}

// Does the local tip sit within what the merged PR contained? A PR head we do not have locally is fetched once.
function coveredByPrHead(repo: string, tip: string, oid: string, number: number): boolean {
  if (tip === oid) return true;
  if (!git.hasCommit(repo, oid) && !(git.fetchPullHead(repo, number) && git.hasCommit(repo, oid))) return false;
  return git.isAncestor(repo, tip, oid);
}

export function memberStatuses(ws: Workset, deps: TriageDeps = {}): MemberStatus[] {
  const config = configOrDefault();
  const prs = deps.prs ?? gh.prsForBranches;
  const bySlug = new Map<string, string[]>();
  for (const m of ws.members) if (m.slug) bySlug.set(m.slug, [...(bySlug.get(m.slug) ?? []), m.branch]);
  const found = new Map<string, Map<string, gh.BranchPr>>();
  for (const [slug, branches] of bySlug) {
    const result = prs(slug, [...new Set(branches)]);
    if (!gh.lastGhError) found.set(slug, result);
  }
  const open = listPointers().filter((p) => pointerState(p, deps.nowMs) === "open");

  return ws.members.map((m): MemberStatus => {
    const repoExists = existsSync(m.repo) && git.heads(m.repo) !== null;
    const tips = repoExists ? git.heads(m.repo)! : {};
    const tip = tips[m.branch];
    const branchExists = tip !== undefined;
    const worktreeExists = !!m.worktree && existsSync(m.worktree);
    const looked = m.slug ? found.get(m.slug) : undefined;
    const hit = looked?.get(m.branch);
    const lookedUp = looked !== undefined;
    const pr: PrState = lookedUp ? (hit ? STORED[hit.pr.state] ?? "nopr" : "nopr") : storedState(m);
    const base = {
      member: m, pr, prNumber: lookedUp ? hit?.pr.number ?? null : m.pr?.number ?? null, prBase: hit?.base ?? null,
      headRefOid: hit?.headRefOid ?? null, prRecord: hit?.pr ?? null, branchExists, repoExists, worktreeExists,
    };
    const worktreeHead = repoExists && worktreeExists ? git.currentBranch(m.worktree!) : null;
    const done = (rest: Partial<MemberStatus> & Pick<MemberStatus, "prunable" | "reason">): MemberStatus =>
      ({ dirty: 0, unpushed: false, cwdOf: null, worktreeHead, ...base, ...rest });

    // Guards that protect uncommitted work and a live session apply even when the repo or branch is gone.
    const files = worktreeExists ? git.dirtyFiles(m.worktree!) : [];
    const dirty = files === null ? 1 : files.length; // an unreadable status counts as dirty
    const wt = worktreeExists ? real(m.worktree!) : null;
    const claimant: Pointer | undefined = wt
      ? open.find((p) => { const c = real(p.cwd); return c === wt || c.startsWith(wt + "/"); })
      : undefined;
    const cwdOf = claimant?.key ?? null;
    let unpushed = false;
    if (branchExists && !git.upstreamGone(m.repo, m.branch)) {
      const ahead = git.aheadOfUpstream(m.repo, m.branch);
      unpushed = ahead !== null ? ahead > 0 : (git.revListCount(m.repo, `${diffBase(m, config)}..${m.branch}`) ?? 0) > 0;
    }
    const state = { dirty, unpushed, cwdOf };

    if (cwdOf) return done({ ...state, prunable: false, reason: `cwd of open session ${cwdOf}` });
    if (dirty > 0) return done({ ...state, prunable: false, reason: `dirty, ${dirty} ${dirty === 1 ? "file" : "files"}` });
    // A worktree that no longer has the member's branch checked out holds something else; leave it alone.
    if (repoExists && worktreeExists && worktreeHead !== m.branch) {
      return done({ ...state, prunable: false, reason: `worktree on ${worktreeHead ?? "detached"}` });
    }
    if (!repoExists) return done({ ...state, prunable: true, reason: "repo gone" });
    if (!branchExists) return done({ ...state, prunable: true, reason: "branch gone" });
    if (pr === "merged" && hit) {
      return coveredByPrHead(m.repo, tip, hit.headRefOid, hit.pr.number)
        ? done({ ...state, prunable: true, reason: "merged" })
        : done({ ...state, prunable: false, reason: "merged PR but local commits beyond its head" });
    }
    if (pr === "open") return done({ ...state, prunable: false, reason: "open PR" });
    if (pr === "closed") return done({ ...state, prunable: false, reason: "closed PR" });
    if (git.upstreamGone(m.repo, m.branch)) {
      const def = git.defaultBranch(m.repo);
      const inDefault = git.isAncestor(m.repo, tip, def) || git.revListCount(m.repo, `${def}..${tip}`) === 0;
      return inDefault
        ? done({ ...state, prunable: true, reason: "remote-gone" })
        : done({ ...state, prunable: false, reason: `remote gone but local commits not in ${def}` });
    }
    return done({ ...state, prunable: false, reason: "unmerged work" });
  });
}

function sessionInfo(ws: Workset, nowMs?: number): { counts: WorksetSummary["sessions"]; keys: string[]; hasOpen: boolean } {
  const pointers = listPointers().filter((p) => p.workset === ws.name || ws.sessions.includes(p.key));
  const counts = { open: 0, stale: 0, closed: 0, last: null as string | null };
  let last = -Infinity;
  for (const p of pointers) {
    counts[pointerState(p, nowMs)]++;
    const times = [p.opened, p.closed].map((t) => (t ? Date.parse(t) : NaN));
    if (p.harness === "claude") { try { times.push(statSync(transcriptPath(p.cwd, p.session)).mtimeMs); } catch { /* no transcript */ } }
    for (const t of times) if (!Number.isNaN(t) && t > last) last = t;
  }
  if (last > -Infinity) counts.last = new Date(last).toISOString();
  return { counts, keys: [...new Set([...ws.sessions, ...pointers.map((p) => p.key)])], hasOpen: counts.open > 0 };
}

export function summarize(ws: Workset, deps: TriageDeps = {}): WorksetSummary {
  const members = memberStatuses(ws, deps);
  const named = isNamed(ws.name);
  const prMix: Record<PrState, number> = { merged: 0, closed: 0, open: 0, nopr: 0 };
  let dirty = 0;
  for (const s of members) { prMix[s.pr]++; dirty += s.dirty; }
  const { counts, keys, hasOpen } = sessionInfo(ws, deps.nowMs);
  let action: Action = "-";
  if (loadLock(ws.name) || keys.some((k) => unreadCount(k) > 0)) action = "review";
  else if (members.length === 0 ? !named && !hasOpen : members.every((s) => s.prunable)) action = "prune";
  else if (!named && members.some((s) => s.pr === "open" || s.unpushed || s.dirty > 0)) action = "name";
  return { name: ws.name, named, members, prMix, dirty, sessions: counts, action };
}

const RANK: Record<Action, number> = { review: 0, prune: 1, name: 2, "-": 3 };
export function summarizeAll(deps: TriageDeps = {}): WorksetSummary[] {
  const out = listWorksets().map((n) => loadWorkset(n)).filter((w): w is Workset => !!w).map((w) => summarize(w, deps));
  const t = (s: WorksetSummary) => (s.sessions.last ? Date.parse(s.sessions.last) : -Infinity);
  return out.sort((a, b) => RANK[a.action] - RANK[b.action] || t(b) - t(a) || a.name.localeCompare(b.name));
}

export function refreshStoredPr(ws: Workset, statuses: MemberStatus[]): boolean {
  let changed = false;
  for (const s of statuses) {
    const m = ws.members.find((x) => x.id === s.member.id);
    if (!m || !s.prRecord || s.prBase === null) continue; // no lookup result: leave the stored PR alone
    const p = s.prRecord;
    if (!m.pr || m.pr.number !== p.number || m.pr.url !== p.url || m.pr.draft !== p.draft || m.pr.state !== p.state) { m.pr = { ...p }; changed = true; }
    if (m.base !== s.prBase || m.base_source !== "pr") { m.base = s.prBase; m.base_source = "pr"; changed = true; }
  }
  return changed;
}
