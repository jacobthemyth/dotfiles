import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Event, Outcome } from "../events";

export const LIVENESS_MS = 24 * 60 * 60 * 1000;
export type Liveness = "alive" | "stale" | "unknown";
const projectsDir = () =>
  process.env.WORKBENCH_CLAUDE_PROJECTS ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
// Claude Code names a project dir after the cwd with every non-alphanumeric character replaced by "-".
export function transcriptPath(cwd: string, session: string): string {
  return join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
}
// The session's transcript: under the encoded cwd, else under any project dir (session ids are UUIDs); null if none.
export function findTranscript(cwd: string, session: string): string | null {
  const direct = transcriptPath(cwd, session);
  if (existsSync(direct)) return direct;
  let dirs: string[];
  try { dirs = readdirSync(projectsDir()); } catch { return null; }
  for (const d of dirs) {
    const f = join(projectsDir(), d, `${session}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}
// alive: transcript written within LIVENESS_MS; stale: found and older; unknown: no transcript found.
export function isAlive(cwd: string, session: string, nowMs = Date.now()): Liveness {
  const f = findTranscript(cwd, session);
  if (!f) return "unknown";
  try { return nowMs - statSync(f).mtimeMs < LIVENESS_MS ? "alive" : "stale"; } catch { return "unknown"; }
}

type In = Record<string, any>;
export function parseClaudeHook(i: unknown): Event | null {
  if (!i || typeof i !== "object") return null;
  const h = i as In;
  if (!h.session_id) return null; // an empty key would make pointer "claude-"
  const s = { harness: "claude", session: String(h.session_id ?? ""), cwd: String(h.cwd ?? "") };
  const toolUseId = h.tool_use_id ? String(h.tool_use_id) : undefined;
  switch (h.hook_event_name) {
    case "SessionStart": return { kind: "sessionStarted", ...s, resumed: h.source !== "startup" && h.source !== "clear" };
    case "SessionEnd": return { kind: "sessionEnded", harness: s.harness, session: s.session };
    case "UserPromptSubmit": return { kind: "promptSubmitted", ...s };
    case "Stop": return { kind: "turnEnded", harness: s.harness, session: s.session };
    case "PreToolUse":
      if (h.tool_name === "Bash") return { kind: "beforeCommand", ...s, command: String(h.tool_input?.command ?? ""), toolUseId };
      if (["Edit", "Write", "NotebookEdit"].includes(h.tool_name)) {
        return { kind: "beforeWrite", ...s, path: String(h.tool_input?.file_path ?? h.tool_input?.notebook_path ?? ""), tool: h.tool_name };
      }
      return null;
    case "PostToolUse": {
      if (h.tool_name !== "Bash") return null;
      const r = h.tool_response;
      const output = typeof r === "string" ? r : [r?.stdout, r?.stderr].filter(Boolean).join("\n");
      return { kind: "afterCommand", ...s, command: String(h.tool_input?.command ?? ""), output, toolUseId };
    }
    default: return null;
  }
}
const EVENT_NAME: Partial<Record<Event["kind"], string>> = {
  beforeWrite: "PreToolUse", beforeCommand: "PreToolUse", sessionStarted: "SessionStart",
  promptSubmitted: "UserPromptSubmit", afterCommand: "PostToolUse",
};
export function renderClaudeOutcome(e: Event, o: Outcome): string {
  const name = EVENT_NAME[e.kind];
  if (!name) return "";
  const spec: Record<string, string> = { hookEventName: name };
  if (o.deny && name === "PreToolUse") { spec.permissionDecision = "deny"; spec.permissionDecisionReason = o.deny; }
  if (o.context) spec.additionalContext = o.context;
  return Object.keys(spec).length > 1 ? JSON.stringify({ hookSpecificOutput: spec }) : "";
}
