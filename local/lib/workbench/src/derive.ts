import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Config } from "./config";
import * as git from "./git";
import * as gh from "./gh";
import { memberId, type Pr, type Workset } from "./workset";

export type Found = {
  repo: string; slug: string | null; branch: string; worktree: string | null;
  pr: Pr | null; base: string | null; main: boolean;
};
export type Deps = { myPrs?: (slug: string) => gh.PrWithBranch[] };

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const foundId = (f: Found) => memberId(f);

function repoDirs(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    const cands = /[*?[{]/.test(root)
      ? [...new Bun.Glob(root.replace(/^\//, "")).scanSync({ cwd: "/", absolute: true, onlyFiles: false })]
      : [root];
    for (const c of cands) {
      if (!isDir(join(c, ".git"))) continue; // a worktree has a .git file, not a directory
      out.add(realpathSync(c));
    }
  }
  return [...out];
}

export function excluded(repo: string, slug: string | null, config: Config): boolean {
  const ex = config.exclude_repos.map((e) => (e.startsWith("/") ? safeReal(e) : e));
  return ex.includes(repo) || ex.includes(basename(repo)) || (slug !== null && ex.includes(slug));
}
const safeReal = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

function extraWorktrees(repo: string, config: Config): string[] {
  const common = git.commonDir(repo);
  if (!common) return [];
  const out: string[] = [];
  for (const wd of config.worktree_dirs) {
    const base = wd.startsWith("/") ? wd : join(repo, wd);
    if (!isDir(base)) continue;
    for (const name of readdirSync(base)) {
      const p = safeReal(join(base, name));
      if (isDir(p) && existsSync(join(p, ".git")) && git.commonDir(p) === common) out.push(p);
    }
  }
  return out;
}

// Several PRs can share a head branch; prefer open over merged over closed.
const STATE_RANK = (s: string) => (s === "OPEN" ? 0 : s === "MERGED" ? 1 : 2);

export function derive(config: Config, deps: Deps = {}): Found[] {
  const myPrs = deps.myPrs ?? gh.myPrs;
  const found: Found[] = [];
  const prCache = new Map<string, gh.PrWithBranch[]>();
  const prsFor = (slug: string) => {
    if (!prCache.has(slug)) prCache.set(slug, myPrs(slug));
    return prCache.get(slug)!;
  };
  for (const repo of repoDirs(config.repo_roots)) {
    const slug = git.remoteSlug(repo);
    if (excluded(repo, slug, config)) continue;
    const wts = git.worktrees(repo);
    const mainPath = safeReal(wts[0]?.path ?? repo);
    const def = git.defaultBranch(repo);
    const prs = slug ? prsFor(slug) : [];
    const seen = new Set<string>();
    const entries = [
      ...wts.map((w) => ({ path: safeReal(w.path), branch: w.branch })),
      ...extraWorktrees(repo, config).map((path) => ({ path, branch: git.currentBranch(path) })),
    ];
    for (const e of entries) {
      if (!e.branch || seen.has(e.path)) continue;
      seen.add(e.path);
      const isMain = e.path === mainPath;
      if (isMain && e.branch === def) continue;
      const hit = prs.filter((p) => p.branch === e.branch)
        .sort((a, b) => STATE_RANK(a.pr.state) - STATE_RANK(b.pr.state))[0];
      found.push({
        repo, slug, branch: e.branch, worktree: e.path, pr: hit?.pr ?? null, base: hit?.base ?? null, main: isMain,
      });
    }
  }
  return found;
}

export function unclaimed(found: Found[], worksets: Workset[]): Found[] {
  const claimed = new Set<string>();
  for (const ws of worksets) {
    for (const m of ws.members) claimed.add(m.id);
    for (const i of ws.ignored) claimed.add(i);
  }
  return found.filter((f) => !claimed.has(foundId(f)));
}

export function prunable(found: Found[]): { found: Found; reason: "merged" | "remote-gone" }[] {
  const out: { found: Found; reason: "merged" | "remote-gone" }[] = [];
  for (const f of found) {
    if (f.main) continue;
    if (f.pr?.state === "MERGED") out.push({ found: f, reason: "merged" });
    else if (git.upstreamGone(f.repo, f.branch)) out.push({ found: f, reason: "remote-gone" });
  }
  return out;
}
