import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { bindSession, loadPointer, pointerKey } from "../src/session";
import { loadWorkset } from "../src/workset";

beforeEach(() => {
  process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-"));
  delete process.env.WORKBENCH_SESSION; delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("session start creates a pointer and a default workset", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  const p = loadPointer(pointerKey("claude", "abc"))!;
  expect(p.workset).toBe("claude-abc");
  expect(loadWorkset("claude-abc")).not.toBeNull();
});
test("resume keeps an existing binding", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  bindSession(pointerKey("claude", "abc"), "spike");
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: true });
  expect(loadPointer(pointerKey("claude", "abc"))!.workset).toBe("spike");
});
test("session end closes the pointer and deletes an empty default workset", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  handle({ kind: "sessionEnded", harness: "claude", session: "abc" });
  expect(loadPointer(pointerKey("claude", "abc"))!.closed).not.toBeNull();
  expect(loadWorkset("claude-abc")).toBeNull();
});
test("session end for an unknown session is a no-op", () => {
  expect(handle({ kind: "sessionEnded", harness: "claude", session: "zzz" })).toEqual({});
});

test("workset use binds the session, creating the workset", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  expect(await run(["use", "spike", "--session", key])).toBe(0);
  expect(loadPointer(key)!.workset).toBe("spike");
  expect(loadWorkset("spike")!.sessions).toContain(key);
  const err = console.error; console.error = () => {};
  try { expect(await run(["use", "spike", "--session", "claude-nope"])).toBe(1); } finally { console.error = err; }
});
