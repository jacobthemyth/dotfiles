import { realpathSync } from "node:fs";
import type { Event, Outcome } from "./events";
import { openPointer, closePointer, pointerKey, currentWorkset } from "./session";
import { createWorkset, loadWorkset, deleteWorkset, saveWorkset, addMember } from "./workset";
import { recognise } from "./record";
import * as git from "./git";
import * as gh from "./gh";
import { activeLocks, commandTouches, denyMessage, lockFor, looksLikeWrite } from "./lock";
import { isAbsolute, resolve } from "node:path";

export function handle(e: Event): Outcome {
  switch (e.kind) {
    case "sessionStarted": {
      const p = openPointer(e.harness, e.session, e.cwd);
      let ws = loadWorkset(p.workset);
      if (!ws) ws = createWorkset(p.workset, p.key);
      if (!ws.sessions.includes(p.key)) { ws.sessions.push(p.key); saveWorkset(ws); }
      return { context: `workbench: this session is "${p.key}", bound to workset "${p.workset}". Change it with \`workbench workset use <name>\`.` };
    }
    case "sessionEnded": {
      const p = closePointer(pointerKey(e.harness, e.session));
      if (p) {
        const ws = loadWorkset(p.key);
        if (ws && ws.members.length === 0) deleteWorkset(p.key);
      }
      return {};
    }
    case "afterCommand": {
      const recorded = recognise(e.command, e.output, e.cwd);
      if (recorded.length === 0) return {};
      const key = pointerKey(e.harness, e.session);
      const name = currentWorkset(key);
      if (!name) return {};
      const ws = loadWorkset(name) ?? createWorkset(name, key);
      for (const r of recorded) {
        if (r.kind === "worktree") {
          const repo = git.repoRoot(e.cwd); if (!repo) continue;
          // PostToolUse fires on failures too: only record a path git lists as a worktree.
          const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
          const want = real(r.path);
          if (!want || !git.worktrees(repo).some((w) => real(w.path) === want)) continue;
          addMember(ws, { repo: git.mainWorktree(repo), slug: git.remoteSlug(repo), branch: r.branch ?? git.currentBranch(r.path) ?? "HEAD", worktree: r.path, added_by: key });
        } else if (r.kind === "push") {
          const repo = git.repoRoot(e.cwd); if (!repo) continue;
          addMember(ws, { repo: git.mainWorktree(repo), slug: git.remoteSlug(repo), branch: r.branch, worktree: e.cwd, added_by: key });
        } else {
          const repo = git.repoRoot(e.cwd);
          const slug = repo && git.remoteSlug(repo);
          const branch = repo && git.currentBranch(repo);
          if (!repo || !slug || !branch) continue;
          const found = gh.prForBranch(slug, branch);
          if (found) addMember(ws, { repo: git.mainWorktree(repo), slug, branch, worktree: e.cwd, pr: found.pr, base: found.base, base_source: found.base ? "pr" : undefined, added_by: key });
        }
      }
      saveWorkset(ws);
      return {};
    }
    case "beforeWrite": {
      const lock = lockFor(isAbsolute(e.path) ? e.path : resolve(e.cwd, e.path));
      return lock ? { deny: denyMessage(lock, lock.matched) } : {};
    }
    case "beforeCommand": {
      if (!looksLikeWrite(e.command)) return {};
      for (const lock of activeLocks()) {
        const hit = commandTouches(e.command, e.cwd, lock.paths);
        if (hit) return { deny: denyMessage(lock, hit) };
      }
      return {};
    }
    case "promptSubmitted": {
      const locks = activeLocks();
      if (locks.length === 0) return {};
      return { context: locks.map((l) => `workbench: review open on workset ${l.workset}; worktrees ${l.paths.join(", ")} are locked until submit or close. Do not edit there.`).join("\n") };
    }
    // The watcher restart is the hook entry's job (cmd/hook.ts --watch), not handle's.
    case "turnEnded": return {};
    default: return {};
  }
}
