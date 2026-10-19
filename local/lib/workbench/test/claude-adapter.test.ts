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
test("transcriptPath replaces every non-alphanumeric character in cwd with a dash", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = "/p";
  expect(transcriptPath("/Users/j/Code/x", "abc")).toBe("/p/-Users-j-Code-x/abc.jsonl");
  expect(transcriptPath("/x/.worktrees/y", "abc")).toBe("/p/-x--worktrees-y/abc.jsonl");
  expect(transcriptPath("/a/b_c.d e", "abc")).toBe("/p/-a-b-c-d-e/abc.jsonl");
});
test("transcriptPath defaults to CLAUDE_CONFIG_DIR/projects", () => {
  const saved = [process.env.WORKBENCH_CLAUDE_PROJECTS, process.env.CLAUDE_CONFIG_DIR];
  delete process.env.WORKBENCH_CLAUDE_PROJECTS;
  process.env.CLAUDE_CONFIG_DIR = "/cfg";
  try { expect(transcriptPath("/w", "s")).toBe("/cfg/projects/-w/s.jsonl"); } finally {
    if (saved[0] === undefined) delete process.env.WORKBENCH_CLAUDE_PROJECTS; else process.env.WORKBENCH_CLAUDE_PROJECTS = saved[0];
    if (saved[1] === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved[1];
  }
});
test("isAlive: fresh and 23h old are alive; 25h old and exactly 24h are stale; missing is unknown", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = _mk(_join(_tmp(), "wbp-"));
  const now = Date.now();
  touchTranscript("/w/a", "fresh", 0, now);
  touchTranscript("/w/a", "h23", 23 * H, now);
  touchTranscript("/w/a", "h25", 25 * H, now);
  touchTranscript("/w/a", "h24", 24 * H, now);
  expect(isAlive("/w/a", "fresh", now)).toBe("alive");
  expect(isAlive("/w/a", "h23", now)).toBe("alive");
  expect(isAlive("/w/a", "h25", now)).toBe("stale");
  expect(isAlive("/w/a", "h24", now)).toBe("stale");
  expect(isAlive("/w/a", "missing", now)).toBe("unknown");
});
test("isAlive finds a hand-encoded dotted worktree path", () => {
  const p = _mk(_join(_tmp(), "wbp-"));
  process.env.WORKBENCH_CLAUDE_PROJECTS = p;
  const now = Date.now();
  _mkdir(_join(p, "-x--worktrees-y"), { recursive: true });
  _wf(_join(p, "-x--worktrees-y", "id1.jsonl"), "{}\n");
  expect(isAlive("/x/.worktrees/y", "id1", now)).toBe("alive");
});
test("isAlive falls back to the session id under a differently named project dir", () => {
  const p = _mk(_join(_tmp(), "wbp-"));
  process.env.WORKBENCH_CLAUDE_PROJECTS = p;
  const now = Date.now();
  _mkdir(_join(p, "-somewhere-else"), { recursive: true });
  _wf(_join(p, "-somewhere-else", "id2.jsonl"), "{}\n");
  expect(isAlive("/x/y", "id2", now)).toBe("alive");
  const t = (now - 25 * H) / 1000; _ut(_join(p, "-somewhere-else", "id2.jsonl"), t, t);
  expect(isAlive("/x/y", "id2", now)).toBe("stale");
});
test("isAlive is unknown when the projects dir does not exist", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = _join(_tmp(), "wbp-does-not-exist-" + Date.now());
  expect(isAlive("/no/such/dir/at/all", "s")).toBe("unknown");
});
