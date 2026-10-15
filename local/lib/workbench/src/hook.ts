import type { Event, Outcome } from "./events";
import { openPointer, closePointer, pointerKey, currentWorkset, joinWorkset } from "./session";
import { createWorkset, loadWorkset, deleteWorkset, saveWorkset, addMember } from "./workset";
import { stopWatcher, unreadCount } from "./inbox";
import { recognise } from "./record";
import { applyChanges, saveSnapshot, snapshot, takeSnapshot } from "./observe";
import * as git from "./git";
import * as gh from "./gh";
import { activeLocks, commandTouches, denyMessage, lockFor, looksLikeWrite } from "./lock";
import { isAbsolute, resolve } from "node:path";

export function handle(e: Event): Outcome {
  switch (e.kind) {
    case "sessionStarted": {
      const p = openPointer(e.harness, e.session, e.cwd);
      joinWorkset(p.key, p.workset);
      return { context: `workbench: this session is "${p.key}", bound to workset "${p.workset}". Change it with \`workbench workset use <name>\`.` };
    }
    case "sessionEnded": {
      const p = closePointer(pointerKey(e.harness, e.session));
      stopWatcher(pointerKey(e.harness, e.session));
      if (p) {
        const ws = loadWorkset(p.key);
        if (ws && ws.members.length === 0) deleteWorkset(p.key);
      }
      return {};
    }
    case "afterCommand": {
      const key = pointerKey(e.harness, e.session);
      const snap = e.toolUseId ? takeSnapshot(key, e.toolUseId) : null;
      const recorded = recognise(e.command, e.output);
      const name = currentWorkset(key);
      if (!name || (!snap && recorded.length === 0)) return {};
      const ws = loadWorkset(name) ?? createWorkset(name, key);
      if (snap) applyChanges(ws, snap, key);
      for (const r of recorded) {
        if (r.kind === "push") {
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
      if (looksLikeWrite(e.command)) {
        for (const lock of activeLocks()) {
          const hit = commandTouches(e.command, e.cwd, lock.paths);
          if (hit) return { deny: denyMessage(lock, hit) };
        }
      }
      const key = pointerKey(e.harness, e.session);
      // Only a bound session's commands are observed; a failed snapshot must never block the command.
      if (e.toolUseId && currentWorkset(key)) {
        try { saveSnapshot(key, e.toolUseId, snapshot(e.command, e.cwd)); } catch (err) { console.error(`workbench hook: ${(err as Error).message}`); }
      }
      return {};
    }
    case "promptSubmitted": {
      const lines = activeLocks().map((l) => `workbench: review open on workset ${l.workset}; worktrees ${l.paths.join(", ")} are locked until submit or close. Do not edit there.`);
      // The watcher gives up after 2 h: the next prompt still surfaces what arrived since (one readdir, no git).
      let unread = 0;
      try { unread = unreadCount(pointerKey(e.harness, e.session)); } catch { /* the lock lines still matter */ }
      if (unread > 0) lines.push(`workbench: ${unread} unread review(s) in your inbox; run \`workbench inbox show\`.`);
      return lines.length ? { context: lines.join("\n") } : {};
    }
    // The watcher restart is the hook entry's job (cmd/hook.ts --watch), not handle's.
    case "turnEnded": return {};
    default: return {};
  }
}
