import { test, expect } from "bun:test";
import { parseClaudeHook, renderClaudeOutcome } from "../src/harness/claude";

const base = { session_id: "abc", cwd: "/w", transcript_path: "/t" };

test("PreToolUse Edit becomes beforeWrite with the file path", () => {
  const e = parseClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/w/a.ts" } });
  expect(e).toEqual({ kind: "beforeWrite", harness: "claude", session: "abc", cwd: "/w", path: "/w/a.ts", tool: "Edit" });
});
test("PreToolUse Bash becomes beforeCommand", () => {
  const e = parseClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
  expect(e?.kind).toBe("beforeCommand");
});
test("Bash events on both sides carry the tool use id that pairs them", () => {
  const pre = parseClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "ls" } });
  const post = parseClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "ls" }, tool_response: { stdout: "" } });
  expect(pre).toMatchObject({ kind: "beforeCommand", toolUseId: "toolu_1" });
  expect(post).toMatchObject({ kind: "afterCommand", toolUseId: "toolu_1" });
});
test("PostToolUse Bash carries output", () => {
  const e = parseClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { stdout: "https://github.com/o/r/pull/7\n" } });
  expect(e).toMatchObject({ kind: "afterCommand", output: expect.stringContaining("pull/7") });
});
test("SessionStart resume is flagged", () => {
  expect(parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "resume" })).toMatchObject({ kind: "sessionStarted", resumed: true });
  expect(parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "startup" })).toMatchObject({ resumed: false });
  expect(parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "clear" })).toMatchObject({ resumed: false });
  expect(parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "compact" })).toMatchObject({ resumed: true });
});
test("unknown events are null", () => {
  expect(parseClaudeHook({ ...base, hook_event_name: "Notification" })).toBeNull();
});
test("non-object input is null", () => {
  expect(parseClaudeHook(null)).toBeNull();
  expect(parseClaudeHook("x")).toBeNull();
});
test("outcome renders hookEventName and context; deny only on PreToolUse", () => {
  const start = parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "startup" })!;
  expect(JSON.parse(renderClaudeOutcome(start, { context: "hi" }))).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hi" } });
  expect(renderClaudeOutcome(start, {})).toBe("");
  const pre = parseClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "x" } })!;
  expect(JSON.parse(renderClaudeOutcome(pre, { deny: "no" })).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "no" });
});
test("an empty or missing session_id is null", () => {
  expect(parseClaudeHook({ ...base, session_id: "", hook_event_name: "SessionStart", source: "startup" })).toBeNull();
  expect(parseClaudeHook({ cwd: "/w", hook_event_name: "UserPromptSubmit" })).toBeNull();
});
test("workbench hook with an unknown harness exits 1, never 2", async () => {
  const { run } = await import("../src/cmd/hook");
  const err = console.error; console.error = () => {};
  try { expect(await run(["nope"])).toBe(1); } finally { console.error = err; }
});

import { mkdtempSync as _mk, mkdirSync as _mkdir, writeFileSync as _wf, utimesSync as _ut } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { join as _join } from "node:path";
import { transcriptPath, isAlive } from "../src/harness/claude";

function touchTranscript(cwd: string, session: string, ageMs: number, nowMs: number) {
  const f = transcriptPath(cwd, session);
  _mkdir(_join(f, ".."), { recursive: true }); _wf(f, "{}\n");
  const t = (nowMs - ageMs) / 1000; _ut(f, t, t);
}
const H = 60 * 60 * 1000;
test("transcriptPath replaces every slash in cwd with a dash", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = "/p";
  expect(transcriptPath("/Users/j/Code/x", "abc")).toBe("/p/-Users-j-Code-x/abc.jsonl");
});
test("isAlive: fresh and 23h old are alive; 25h old, exactly 24h and missing are not", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = _mk(_join(_tmp(), "wbp-"));
  const now = Date.now();
  touchTranscript("/w/a", "fresh", 0, now);
  touchTranscript("/w/a", "h23", 23 * H, now);
  touchTranscript("/w/a", "h25", 25 * H, now);
  touchTranscript("/w/a", "h24", 24 * H, now);
  expect(isAlive("/w/a", "fresh", now)).toBe(true);
  expect(isAlive("/w/a", "h23", now)).toBe(true);
  expect(isAlive("/w/a", "h25", now)).toBe(false);
  expect(isAlive("/w/a", "h24", now)).toBe(false);
  expect(isAlive("/w/a", "missing", now)).toBe(false);
});
test("isAlive does not throw when cwd does not exist on disk", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = _mk(_join(_tmp(), "wbp-"));
  expect(isAlive("/no/such/dir/at/all", "s")).toBe(false);
});
