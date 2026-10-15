import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "./config";
import { excluded } from "./derive";
import * as git from "./git";
import { sub } from "./paths";
import { readJson, removeFile, writeJson } from "./store";
import { addMember, findMember, memberId, removeMember, type Member, type Workset } from "./workset";

// Membership comes from what git changed during a command, never from parsing the command:
// loops, variables, scripts and aliases all look the same here. The command text only names
// extra directories to watch (`git -C <repo>`, `cd <repo> && ...`).
type RepoState = { main: string; heads: Record<string, string>; worktrees: Record<string, string | null> };
export type Snapshot = RepoState[];

const MAX_DIRS = 8;
const STALE_MS = 24 * 60 * 60 * 1000;
const dir = () => sub("snapshots");
const file = (key: string, toolUseId: string) => join(dir(), `${key}.${toolUseId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const config = (): Config | null => { try { return loadConfig(); } catch { return null; } };

function candidateDirs(command: string, cwd: string): string[] {
  const out = [cwd];
  for (const tok of command.split(/[\s'"`=;|&()<>]+/)) {
    if (out.length >= MAX_DIRS) break;
    if (!tok.startsWith("/") && !tok.startsWith("~/")) continue;
    let p = tok.startsWith("~/") ? join(homedir(), tok.slice(2)) : tok;
    while (p !== "/" && !isDir(p)) p = dirname(p);
    if (p !== "/" && !out.includes(p)) out.push(p);
  }
  return out;
}

function state(main: string, wts = git.worktrees(main)): RepoState | null {
  const heads = git.heads(main);
  if (!heads) return null;
  return { main, heads, worktrees: Object.fromEntries(wts.map((w) => [w.path, w.branch])) };
}

export function snapshot(command: string, cwd: string): Snapshot {
  const cfg = config();
  const seen = new Set<string>();
  const out: Snapshot = [];
  for (const d of candidateDirs(command, cwd)) {
    const common = git.commonDir(d);
    if (!common || seen.has(common)) continue;
    seen.add(common);
    const wts = git.worktrees(d);
    const main = wts[0]?.path;
    if (!main) continue;
    if (cfg && excluded(main, cfg.exclude_repos.length ? git.remoteSlug(main) : null, cfg)) continue;
    const s = state(main, wts);
    if (s) out.push(s);
  }
  return out;
}

function pruneStale(): void {
  if (!existsSync(dir())) return;
  const cutoff = Date.now() - STALE_MS;
  for (const f of readdirSync(dir())) {
    try { if (statSync(join(dir(), f)).mtimeMs < cutoff) removeFile(join(dir(), f)); } catch { /* raced with another prune */ }
  }
}
export function saveSnapshot(key: string, toolUseId: string, snap: Snapshot): void {
  pruneStale();
  if (snap.length) writeJson(file(key, toolUseId), snap);
}
export function takeSnapshot(key: string, toolUseId: string): Snapshot | null {
  const f = file(key, toolUseId);
  const snap = readJson<Snapshot>(f);
  removeFile(f);
  return snap;
}

// A member's inferred base is the nearest other member its tip descends from; none means the default branch.
function inferBases(ws: Workset, repo: string, heads: Record<string, string>): void {
  const ms = ws.members.filter((m) => m.repo === repo && m.role === "work" && heads[m.branch]);
  const below = new Map(ms.map((m) => [m, new Set(git.mergedInto(repo, heads[m.branch]).filter((b) => heads[b] !== heads[m.branch]))]));
  for (const m of ms) {
    if (m.base !== null && m.base_source !== "inferred") continue;
    let best: Member | null = null;
    for (const o of ms) {
      if (o !== m && below.get(m)!.has(o.branch) && (!best || below.get(o)!.size > below.get(best)!.size)) best = o;
    }
    m.base = best?.branch ?? null;
    m.base_source = best ? "inferred" : null;
  }
}

// Records in `ws` what changed since `before`: branches created or moved and branches checked out in a
// new worktree join; a worktree that went away is cleared; a member whose branch and worktree are both
// gone leaves. Commits on the default branch, detached worktrees and switching an existing worktree to an
// existing branch (reading someone's branch) record nothing.
export function applyChanges(ws: Workset, before: Snapshot, by: string): void {
  for (const b of before) {
    const a = state(b.main);
    if (!a) continue;
    let changed = false;
    let slug: string | null | undefined;
    const slugOf = () => (slug === undefined ? (slug = git.remoteSlug(b.main)) : slug);
    const wtOf = (branch: string) => Object.entries(a.worktrees).find(([, br]) => br === branch)?.[0] ?? null;

    const moved = Object.keys(a.heads).filter((br) => a.heads[br] !== b.heads[br]);
    const inNewWorktree = Object.entries(a.worktrees).filter(([p, br]) => br && !(p in b.worktrees)).map(([, br]) => br!);
    const touched = [...new Set([...moved, ...inNewWorktree])];
    if (touched.length) {
      const def = git.defaultBranch(b.main);
      for (const branch of touched) {
        if (branch === def) continue;
        const input = { repo: b.main, slug: slugOf(), branch };
        if (ws.ignored.includes(memberId(input))) continue;
        const existing = findMember(ws, input);
        if (existing) existing.worktree = wtOf(branch) ?? existing.worktree;
        else addMember(ws, { ...input, worktree: wtOf(branch) ?? undefined, added_by: by });
        changed = true;
      }
    }
    for (const m of ws.members) {
      if (m.repo === b.main && m.worktree && m.worktree in b.worktrees && a.worktrees[m.worktree] !== m.branch) {
        m.worktree = null; changed = true;
      }
    }
    for (const br of Object.keys(b.heads)) {
      if (br in a.heads) continue;
      const m = ws.members.find((x) => x.repo === b.main && x.branch === br);
      if (m && !m.worktree) { removeMember(ws, m.id); changed = true; }
    }
    if (changed) inferBases(ws, b.main, a.heads);
  }
}
