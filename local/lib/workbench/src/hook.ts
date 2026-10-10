import type { Event, Outcome } from "./events";
import { openPointer, closePointer, pointerKey } from "./session";
import { createWorkset, loadWorkset, deleteWorkset, saveWorkset } from "./workset";

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
    default: return {};
  }
}
