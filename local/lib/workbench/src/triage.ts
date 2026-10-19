import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as gh from "./gh";
import * as git from "./git";
import { loadConfig, type Config } from "./config";
import { unreadCount } from "./inbox";
import { loadLock } from "./review";
import { listPointers, pointerState, type Pointer } from "./session";
import { baseSource, diffBase } from "./stack";
import { findTranscript } from "./harness/claude";
import { listWorksets, loadWorkset, type Member, type Pr, type Workset } from "./workset";

export type PrState = "merged" | "closed" | "open" | "nopr";
export type MemberStatus = {
  member: Member; pr: PrState; prNumber: number | null; prBase: string | null;
  headRefOid: string | null; // PR head commit from a successful lookup; null otherwise
  prRecord: Pr | null;       // the looked-up PR, for refreshStoredPr; null when nothing was looked up
  headCovers: boolean;       // the local tip is within the looked-up PR's head (the head-SHA guard)
  branchExists: boolean; repoExists: boolean; worktreeExists: boolean;
  tip: string | null;        // the branch's local tip; null when the branch is gone
  // The worktree git says has the branch checked out (the stored `worktree` is only a hint); null when none.
  realWorktree: string | null;
  mainCheckout: boolean;     // realWorktree is the repo's main worktree, which prune never removes
  dirty: number;             // uncommitted files across the stored and the real worktree
  dirtyWorktrees: string[];  // realpaths of those worktrees that are dirty
  unpushed: boolean;
  cwdOf: string | null;
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

// Does the local tip sit within what the PR contained? A PR head we do not have locally is fetched once when `fetch`.
function coveredByPrHead(repo: string, tip: string, oid: string, number: number, fetch: boolean): boolean {
  if (tip === oid) return true;
  if (!git.hasCommit(repo, oid) && !(fetch && git.fetchPullHead(repo, number) && git.hasCommit(repo, oid))) return false;
  return git.isAncestor(repo, tip, oid);
}

// Is `cwd` inside worktree `wt` and not inside another worktree nested under it (worktrees often live in <repo>/.worktrees)?
function within(cwd: string, wt: string, others: string[]): boolean {
  if (cwd === wt) return true;
  if (!cwd.startsWith(wt + "/")) return false;
  return !others.some((o) => o !== wt && o.startsWith(wt + "/") && (cwd === o || cwd.startsWith(o + "/")));
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
  const worktreeCache = new Map<string, { path: string; branch: string | null }[]>();
  const worktreesOf = (repo: string) => {
    if (!worktreeCache.has(repo)) worktreeCache.set(repo, git.worktrees(repo));
    return worktreeCache.get(repo)!;
  };

  return ws.members.map((m): MemberStatus => {
    const tips = existsSync(m.repo) ? git.heads(m.repo) : null;
    const repoExists = tips !== null;
    const tip = tips?.[m.branch];
    const branchExists = tip !== undefined;
    const worktreeExists = !!m.worktree && existsSync(m.worktree);
    const looked = m.slug ? found.get(m.slug) : undefined;
    const hit = looked?.get(m.branch);
    const lookedUp = looked !== undefined;
    const pr: PrState = lookedUp ? (hit ? STORED[hit.pr.state] ?? "nopr" : "nopr") : storedState(m);
    const list = repoExists ? worktreesOf(m.repo) : [];
    const entry = branchExists ? list.find((w) => w.branch === m.branch) : undefined;
    const headCovers = !!hit && branchExists && coveredByPrHead(m.repo, tip, hit.headRefOid, hit.pr.number, pr === "merged");
    const base = {
      member: m, pr, prNumber: lookedUp ? hit?.pr.number ?? null : m.pr?.number ?? null, prBase: hit?.base ?? null,
      headRefOid: hit?.headRefOid ?? null, prRecord: hit?.pr ?? null, headCovers, branchExists, repoExists, worktreeExists,
      tip: tip ?? null, realWorktree: entry?.path ?? null, mainCheckout: !!entry && entry === list[0],
    };

    // Guards that protect uncommitted work and a live session apply to the stored worktree and to the one git
    // says has the branch, even when the repo or branch is gone.
    const paths = [...new Set([...(worktreeExists ? [m.worktree!] : []), ...(entry ? [entry.path] : [])].map(real))];
    let dirty = 0;
    const dirtyWorktrees: string[] = [];
    for (const wt of paths) {
      const files = git.dirtyFiles(wt);
      const n = files === null ? 1 : files.length; // an unreadable status counts as dirty
      if (n > 0) { dirty += n; dirtyWorktrees.push(wt); }
    }
    const others = list.map((w) => real(w.path));
    const claimant: Pointer | undefined = open.find((p) => { const c = real(p.cwd); return paths.some((wt) => within(c, wt, others)); });
    const cwdOf = claimant?.key ?? null;
    let unpushed = false;
    if (branchExists && !git.upstreamGone(m.repo, m.branch)) {
      const ahead = git.aheadOfUpstream(m.repo, m.branch);
      unpushed = ahead !== null ? ahead > 0 : (git.revListCount(m.repo, `${diffBase(m, config)}..${m.branch}`) ?? 0) > 0;
    }
    const done = (rest: Pick<MemberStatus, "prunable" | "reason">): MemberStatus =>
      ({ ...base, dirty, dirtyWorktrees, unpushed, cwdOf, ...rest });

    if (cwdOf) return done({ prunable: false, reason: `cwd of open session ${cwdOf}` });
    if (dirty > 0) return done({ prunable: false, reason: `dirty, ${dirty} ${dirty === 1 ? "file" : "files"}` });
    if (!repoExists) return done({ prunable: true, reason: "repo gone" });
    if (!branchExists) return done({ prunable: true, reason: "branch gone" });
    if (pr === "merged" && hit) {
      return headCovers
        ? done({ prunable: true, reason: "merged" })
        : done({ prunable: false, reason: "merged PR but local commits beyond its head" });
    }
    if (pr === "open") return done({ prunable: false, reason: "open PR" });
    // The tip already being in the default branch is proof the commits live on; a closed PR or a gone
    // upstream says nothing against that.
    const def = git.defaultBranch(m.repo);
    const inDefault = () => git.isAncestor(m.repo, tip, def) || git.revListCount(m.repo, `${def}..${tip}`) === 0;
    if (pr === "closed") {
      return inDefault()
        ? done({ prunable: true, reason: `merged into ${def} (closed PR)` })
        : done({ prunable: false, reason: "closed PR" });
    }
    if (git.upstreamGone(m.repo, m.branch)) {
      return inDefault()
        ? done({ prunable: true, reason: "remote-gone" })
        : done({ prunable: false, reason: `remote gone but local commits not in ${def}` });
    }
    return done({ prunable: false, reason: "unmerged work" });
  });
}

// Every pointer bound to the workset, by its own binding or by the workset's session list.
export function boundPointers(ws: Workset): Pointer[] {
  return listPointers().filter((p) => p.workset === ws.name || ws.sessions.includes(p.key));
}
export function boundKeys(ws: Workset): string[] {
  return [...new Set([...ws.sessions, ...boundPointers(ws).map((p) => p.key)])];
}

function sessionInfo(ws: Workset, nowMs?: number): { counts: WorksetSummary["sessions"]; keys: string[]; hasOpen: boolean } {
  const pointers = boundPointers(ws);
  const counts = { open: 0, stale: 0, closed: 0, last: null as string | null };
  let last = -Infinity;
  for (const p of pointers) {
    counts[pointerState(p, nowMs)]++;
    const times = [p.opened, p.closed].map((t) => (t ? Date.parse(t) : NaN));
    if (p.harness === "claude") { const f = findTranscript(p.cwd, p.session); if (f) { try { times.push(statSync(f).mtimeMs); } catch { /* gone */ } } }
    for (const t of times) if (!Number.isNaN(t) && t > last) last = t;
  }
  if (last > -Infinity) counts.last = new Date(last).toISOString();
  return { counts, keys: boundKeys(ws), hasOpen: counts.open > 0 };
}

export function summarize(ws: Workset, deps: TriageDeps = {}): WorksetSummary {
  const members = memberStatuses(ws, deps);
  const named = isNamed(ws.name);
  const prMix: Record<PrState, number> = { merged: 0, closed: 0, open: 0, nopr: 0 };
  const dirtyWorktrees = new Set<string>();
  for (const s of members) { prMix[s.pr]++; for (const w of s.dirtyWorktrees) dirtyWorktrees.add(w); }
  const { counts, keys, hasOpen } = sessionInfo(ws, deps.nowMs);
  let action: Action = "-";
  if (loadLock(ws.name) || keys.some((k) => unreadCount(k) > 0)) action = "review";
  else if (!hasOpen && (members.length === 0 ? !named : members.every((s) => s.prunable))) action = "prune";
  else if (!named && members.some((s) => s.pr === "open" || s.unpushed || s.dirty > 0)) action = "name";
  return { name: ws.name, named, members, prMix, dirty: dirtyWorktrees.size, sessions: counts, action };
}

const RANK: Record<Action, number> = { review: 0, prune: 1, name: 2, "-": 3 };
export function summarizeAll(deps: TriageDeps = {}): WorksetSummary[] {
  const out = listWorksets().map((n) => loadWorkset(n)).filter((w): w is Workset => !!w).map((w) => summarize(w, deps));
  const t = (s: WorksetSummary) => (s.sessions.last ? Date.parse(s.sessions.last) : -Infinity);
  return out.sort((a, b) => RANK[a.action] - RANK[b.action] || t(b) - t(a) || a.name.localeCompare(b.name));
}

// Adopts a looked-up PR and its base, only for a member whose tip passed the head-SHA guard (a PR found by
// branch name alone may belong to an older branch of the same name). A declared base is never replaced.
export function refreshStoredPr(ws: Workset, statuses: MemberStatus[]): boolean {
  let changed = false;
  for (const s of statuses) {
    const m = ws.members.find((x) => x.id === s.member.id);
    if (!m || !s.prRecord || s.prBase === null || !s.headCovers) continue;
    const p = s.prRecord;
    if (!m.pr || m.pr.number !== p.number || m.pr.url !== p.url || m.pr.draft !== p.draft || m.pr.state !== p.state) { m.pr = { ...p }; changed = true; }
    if (baseSource(m) === "declared") continue;
    if (m.base !== s.prBase || m.base_source !== "pr") { m.base = s.prBase; m.base_source = "pr"; changed = true; }
  }
  return changed;
}
