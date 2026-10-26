import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { bindSession, loadPointer, pointerKey, useWorkset } from "../src/session";
import { createWorkset, listWorksets, loadWorkset } from "../src/workset";

beforeEach(() => {
  process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-"));
  delete process.env.WORKBENCH_SESSION; delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("session start creates an unbound pointer and no workset", () => {
  const out = handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  const p = loadPointer(pointerKey("claude", "abc"))!;
  expect(p.workset).toBeNull();
  expect(listWorksets()).toEqual([]);
  expect(out.context).toContain("not bound to a workset");
  expect(out.context).toContain("workbench workset use <name>");
});
test("resume keeps an existing binding", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  bindSession(pointerKey("claude", "abc"), "spike");
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: true });
  expect(loadPointer(pointerKey("claude", "abc"))!.workset).toBe("spike");
});
test("session end closes the pointer and leaves the bound workset alone, even empty", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  createWorkset("spike");
  useWorkset(pointerKey("claude", "abc"), "spike");
  handle({ kind: "sessionEnded", harness: "claude", session: "abc" });
  expect(loadPointer(pointerKey("claude", "abc"))!.closed).not.toBeNull();
  expect(loadWorkset("spike")!.members).toEqual([]);
});
test("session end for an unknown session is a no-op", () => {
  expect(handle({ kind: "sessionEnded", harness: "claude", session: "zzz" })).toEqual({});
});

test("workset use refuses a workset that does not exist", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  const err = console.error; const lines: string[] = []; console.error = (m: string) => lines.push(m);
  try { expect(await run(["use", "spike", "--session", key])).toBe(1); } finally { console.error = err; }
  expect(lines.join("\n")).toContain('no workset "spike"');
  expect(loadPointer(key)!.workset).toBeNull();
  expect(listWorksets()).toEqual([]);
});
test("workset use binds the session to an existing workset", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  createWorkset("spike");
  expect(await run(["use", "spike", "--session", key])).toBe(0);
  expect(loadPointer(key)!.workset).toBe("spike");
  expect(loadWorkset("spike")!.sessions).toContain(key);
  const err = console.error; console.error = () => {};
  try { expect(await run(["use", "spike", "--session", "claude-nope"])).toBe(1); } finally { console.error = err; }
});

const start = () => handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });

test("workset use leaves the previous workset's sessions", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  start();
  createWorkset("spike"); createWorkset("other");
  expect(await run(["use", "spike", "--session", key])).toBe(0);
  expect(await run(["use", "other", "--session", key])).toBe(0);
  expect(loadWorkset("spike")!.sessions).not.toContain(key);
  expect(loadWorkset("other")!.sessions).toEqual([key]);
  expect(loadPointer(key)!.workset).toBe("other");
});

test("workset unbind clears the binding and leaves the workset's sessions", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  start();
  createWorkset("spike");
  expect(await run(["use", "spike", "--session", key])).toBe(0);
  expect(await run(["unbind", "--session", key])).toBe(0);
  expect(loadPointer(key)!.workset).toBeNull();
  expect(loadWorkset("spike")!.sessions).toEqual([]);
  expect(listWorksets()).toEqual(["spike"]);
});
test("workset unbind on an unbound session is a no-op, and fails for an unknown session", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  start();
  expect(await run(["unbind", "--session", key])).toBe(0);
  expect(loadPointer(key)!.workset).toBeNull();
  const err = console.error; console.error = () => {};
  try { expect(await run(["unbind", "--session", "claude-nope"])).toBe(1); } finally { console.error = err; }
});

import { mkdirSync as _mkdir, writeFileSync as _wf, utimesSync as _ut } from "node:fs";
import { transcriptPath } from "../src/harness/claude";
import { closeStale, pointerState, savePointer, type Pointer } from "../src/session";

const mkPtr = (over: Partial<Pointer> = {}): Pointer =>
  ({ key: "claude-s1", harness: "claude", session: "s1", workset: "claude-s1", cwd: "/w/x", opened: "t", closed: null, ...over });
function transcript(ageMs: number) {
  const f = transcriptPath("/w/x", "s1");
  _mkdir(join(f, ".."), { recursive: true }); _wf(f, "{}\n");
  const t = (Date.now() - ageMs) / 1000; _ut(f, t, t);
}
test("pointerState: closed wins regardless of transcript", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = mkdtempSync(join(tmpdir(), "wbp-"));
  transcript(0);
  expect(pointerState(mkPtr({ closed: "2026-01-01T00:00:00Z" }))).toBe("closed");
});
test("pointerState: open for a live transcript, stale only for a transcript older than a day", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = mkdtempSync(join(tmpdir(), "wbp-"));
  transcript(0);
  expect(pointerState(mkPtr())).toBe("open");
  transcript(25 * 3600 * 1000);
  expect(pointerState(mkPtr())).toBe("stale");
});
test("pointerState: no transcript found is unknown, which counts as open", () => {
  process.env.WORKBENCH_CLAUDE_PROJECTS = mkdtempSync(join(tmpdir(), "wbp-"));
  expect(pointerState(mkPtr())).toBe("open");
  process.env.WORKBENCH_CLAUDE_PROJECTS = join(tmpdir(), "wbp-none-" + Date.now());
  expect(pointerState(mkPtr())).toBe("open");
});
test("pointerState: unknown harness is open when not closed", () => {
  expect(pointerState(mkPtr({ harness: "other" }))).toBe("open");
});
test("closeStale records closed and closed_reason and round-trips", () => {
  const p = mkPtr(); savePointer(p);
  closeStale(p);
  const back = loadPointer("claude-s1")!;
  expect(back.closed).not.toBeNull();
  expect(back.closed_reason).toBe("stale");
});
