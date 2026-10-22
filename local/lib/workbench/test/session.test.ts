import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { bindSession, loadPointer, pointerKey } from "../src/session";
import { addMember, createWorkset, loadWorkset, saveWorkset } from "../src/workset";

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

const start = () => handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
const end = () => handle({ kind: "sessionEnded", harness: "claude", session: "abc" });

test("rebound session: empty default workset is deleted on end, bound workset survives", () => {
  start();
  bindSession(pointerKey("claude", "abc"), "spike");
  const spike = createWorkset("spike", "claude-abc");
  end();
  expect(loadWorkset("claude-abc")).toBeNull();
  expect(loadWorkset(spike.name)).not.toBeNull();
});
test("default workset with a member survives session end", () => {
  start();
  const ws = loadWorkset("claude-abc")!;
  addMember(ws, { repo: "/r", branch: "b", added_by: "claude-abc" });
  saveWorkset(ws);
  end();
  expect(loadWorkset("claude-abc")).not.toBeNull();
});

test("workset use leaves the previous workset's sessions", async () => {
  const { run } = await import("../src/cmd/workset");
  const key = pointerKey("claude", "abc");
  start();
  expect(await run(["use", "spike", "--session", key])).toBe(0);
  expect(await run(["use", "other", "--session", key])).toBe(0);
  expect(loadWorkset("spike")!.sessions).not.toContain(key);
  expect(loadWorkset("claude-abc")!.sessions).not.toContain(key);
  expect(loadWorkset("other")!.sessions).toEqual([key]);
  expect(loadPointer(key)!.workset).toBe("other");
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

// `workset use <named>` and the default workset left behind.
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", DEF = `claude-${SID}`;
const SID2 = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff", DEF2 = `claude-${SID2}`;
async function captureRun(args: string[], io?: { confirm?: (q: string) => Promise<boolean> }) {
  const { run } = await import("../src/cmd/workset");
  const o: string[] = [], e: string[] = [];
  const lo = console.log, le = console.error;
  console.log = (...a) => o.push(a.join(" ")); console.error = (...a) => e.push(a.join(" "));
  try { return { code: await run(args, io), out: o.join("\n"), err: e.join("\n") }; } finally { console.log = lo; console.error = le; }
}
function defaultWithMembers() {
  handle({ kind: "sessionStarted", harness: "claude", session: SID, cwd: "/w", resumed: false });
  const ws = loadWorkset(DEF)!;
  addMember(ws, { repo: "/r", branch: "b1", base: "main", role: "throwaway", added_by: DEF });
  addMember(ws, { repo: "/r", branch: "b2", base: "b1", added_by: DEF });
  saveWorkset(ws);
  return pointerKey("claude", SID);
}

test("use --move carries the default workset's members into the named one and forgets it", async () => {
  const key = defaultWithMembers();
  const r = await captureRun(["use", "spike", "--session", key, "--move"]);
  expect(r.code).toBe(0);
  expect(loadPointer(key)!.workset).toBe("spike");
  const spike = loadWorkset("spike")!;
  expect(spike.members.map((m) => [m.branch, m.base, m.role])).toEqual([["b1", "main", "throwaway"], ["b2", "b1", "work"]]);
  expect(loadWorkset(DEF)).toBeNull();
  expect(r.out).toContain(`moved 2 members from ${DEF} into spike`);
  expect(r.out).toContain("deleted workset");
});

test("use --keep leaves the default workset alone", async () => {
  const key = defaultWithMembers();
  const r = await captureRun(["use", "spike", "--session", key, "--keep"]);
  expect(r.code).toBe(0);
  expect(loadWorkset(DEF)!.members.length).toBe(2);
  expect(loadWorkset("spike")!.members).toEqual([]);
  expect(r.out).not.toContain("moved");
});

test("use without a flag asks when it can, and otherwise prints the hint and keeps the workset", async () => {
  const key = defaultWithMembers();
  let asked = "";
  const yes = await captureRun(["use", "spike", "--session", key], { confirm: async (q) => { asked = q; return true; } });
  expect(yes.code).toBe(0);
  expect(asked).toContain(`Move 2 members from ${DEF} into spike and forget it?`);
  expect(loadWorkset(DEF)).toBeNull();
  expect(loadWorkset("spike")!.members.length).toBe(2);

  const key2 = (() => { handle({ kind: "sessionStarted", harness: "claude", session: SID2, cwd: "/w", resumed: false }); const ws = loadWorkset(DEF2)!; addMember(ws, { repo: "/r", branch: "b3", added_by: DEF2 }); saveWorkset(ws); return pointerKey("claude", SID2); })();
  const no = await captureRun(["use", "spike", "--session", key2], { confirm: async () => false });
  expect(no.code).toBe(0);
  expect(loadWorkset(DEF2)!.members.length).toBe(1);

  const SID3 = "aaaaaaaa-bbbb-cccc-dddd-000000000003", DEF3 = `claude-${SID3}`;
  handle({ kind: "sessionStarted", harness: "claude", session: SID3, cwd: "/w", resumed: false });
  const ws3 = loadWorkset(DEF3)!; addMember(ws3, { repo: "/r", branch: "b4", added_by: DEF3 }); saveWorkset(ws3);
  const hint = await captureRun(["use", "other", "--session", pointerKey("claude", SID3)]); // no confirm and no TTY under bun test
  expect(hint.code).toBe(0);
  expect(hint.err).toContain(`${DEF3} still has 1 member; rerun with --move to move it into other and forget ${DEF3}, or --keep`);
  expect(loadWorkset(DEF3)!.members.length).toBe(1);
});

test("use --move keeps the default workset when another session is open on it, and offers nothing for a named or empty one", async () => {
  const key = defaultWithMembers();
  savePointer({ key: "claude-other", harness: "claude", session: "other", workset: DEF, cwd: "/w", opened: "t", closed: null });
  const r = await captureRun(["use", "spike", "--session", key, "--move"]);
  expect(r.code).toBe(0);
  expect(loadWorkset("spike")!.members.length).toBe(2);
  expect(loadWorkset(DEF)!.members.length).toBe(2);
  expect(r.out).toContain("refused: open session claude-other");
  // from a named workset, or an empty default one, there is nothing to offer
  const quiet = await captureRun(["use", "third", "--session", key]);
  expect(quiet.code).toBe(0);
  expect(quiet.err).toBe("");
  expect(quiet.out).toBe(`${key} -> third`);
});
