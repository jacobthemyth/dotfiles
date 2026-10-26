import type { Event, Outcome } from "./events";
import { openPointer, closePointer, pointerKey } from "./session";
import { stopWatcher, unreadCount } from "./inbox";
import { activeLocks, commandTouches, denyMessage, lockFor, looksLikeWrite } from "./lock";
import { isAbsolute, resolve } from "node:path";

export function handle(e: Event): Outcome {
  switch (e.kind) {
    case "sessionStarted": {
      const p = openPointer(e.harness, e.session, e.cwd);
      if (!p.workset) return { context: `workbench: this session is "${p.key}", not bound to a workset. Run \`workbench workset use <name>\` to receive its reviews.` };
      return { context: `workbench: this session is "${p.key}", bound to workset "${p.workset}". Change it with \`workbench workset use <name>\`.` };
    }
    case "sessionEnded": {
      closePointer(pointerKey(e.harness, e.session));
      stopWatcher(pointerKey(e.harness, e.session));
      return {};
    }
    // Membership is curated by hand (`workset add`, `adopt`, `rm`): a command's effect on branches is never recorded.
    case "afterCommand": return {};
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
