import type { Event, Outcome } from "../events";

type In = Record<string, any>;
export function parseClaudeHook(i: unknown): Event | null {
  if (!i || typeof i !== "object") return null;
  const h = i as In;
  if (!h.session_id) return null; // an empty key would make pointer "claude-"
  const s = { harness: "claude", session: String(h.session_id ?? ""), cwd: String(h.cwd ?? "") };
  switch (h.hook_event_name) {
    case "SessionStart": return { kind: "sessionStarted", ...s, resumed: h.source !== "startup" && h.source !== "clear" };
    case "SessionEnd": return { kind: "sessionEnded", harness: s.harness, session: s.session };
    case "UserPromptSubmit": return { kind: "promptSubmitted", ...s };
    case "Stop": return { kind: "turnEnded", harness: s.harness, session: s.session };
    case "PreToolUse":
      if (h.tool_name === "Bash") return { kind: "beforeCommand", ...s, command: String(h.tool_input?.command ?? "") };
      if (["Edit", "Write", "NotebookEdit"].includes(h.tool_name)) {
        return { kind: "beforeWrite", ...s, path: String(h.tool_input?.file_path ?? h.tool_input?.notebook_path ?? ""), tool: h.tool_name };
      }
      return null;
    case "PostToolUse": {
      if (h.tool_name !== "Bash") return null;
      const r = h.tool_response;
      const output = typeof r === "string" ? r : [r?.stdout, r?.stderr].filter(Boolean).join("\n");
      return { kind: "afterCommand", ...s, command: String(h.tool_input?.command ?? ""), output };
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
