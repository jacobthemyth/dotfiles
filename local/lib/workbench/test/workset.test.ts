import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { sub } from "../src/paths";
import { readJson, writeJson } from "../src/store";
import { listPointers, savePointer, type Pointer } from "../src/session";
import { archiveFile } from "../src/review";
import { createWorkset, loadWorkset, addMember, saveWorkset, listWorksets, removeMember, renameWorkset } from "../src/workset";

beforeEach(() => { process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-state-")); });

test("create, add member, reload", () => {
  const ws = createWorkset("spike", "hand");
  const m = addMember(ws, { repo: "/r/infra", slug: "abridgeai/infrastructure", branch: "jakesmith/spike", worktree: "/r/infra/.worktrees/spike", added_by: "hand" });
  saveWorkset(ws);
  const back = loadWorkset("spike")!;
  expect(back.members).toHaveLength(1);
  expect(back.members[0].id).toBe("abridgeai/infrastructure#jakesmith/spike");
  expect(back.members[0].role).toBe("work");
  expect(m.order).toBeNull();
  expect(listWorksets()).toEqual(["spike"]);
});

test("adding the same branch twice updates instead of duplicating", () => {
  const ws = createWorkset("spike", "hand");
  addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: null, added_by: "hand" });
  addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: "/r/.worktrees/b", added_by: "claude-1" });
  expect(ws.members).toHaveLength(1);
  expect(ws.members[0].worktree).toBe("/r/.worktrees/b");
});

test("a branch declared by path and recorded by slug is one member", () => {
  const ws = createWorkset("spike", "hand");
  addMember(ws, { repo: "/r", slug: null, branch: "b", added_by: "hand" });
  addMember(ws, { repo: "/r", slug: "o/r", branch: "b", worktree: "/r/.worktrees/b", added_by: "claude-1" });
  expect(ws.members).toHaveLength(1);
  expect(ws.members[0]).toMatchObject({ id: "/r#b", worktree: "/r/.worktrees/b" });
});

test("remove member", () => {
  const ws = createWorkset("spike", "hand");
  const m = addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: null, added_by: "hand" });
  removeMember(ws, m.id);
  expect(ws.members).toHaveLength(0);
});

test("invalid name rejected", () => {
  expect(() => createWorkset("bad name!", "hand")).toThrow();
});

const ptr = (key: string, workset: string): Pointer => ({ key, harness: "claude", session: key, workset, cwd: "/r", opened: "2026-01-01T00:00:00Z", closed: null });
const lockPath = (ws: string) => join(sub("locks"), `${ws}.json`);
const inboxPath = (key: string, id: string) => join(sub("inbox"), key, `${id}.json`);

test("renameWorkset moves the file, pointers, review archives and inbox files", () => {
  const ws = createWorkset("claude-abc", "claude-1");
  saveWorkset(ws);
  savePointer(ptr("p1", "claude-abc")); savePointer(ptr("p2", "claude-abc")); savePointer(ptr("p3", "other"));
  writeJson(archiveFile("claude-abc", "x"), { id: "x" });
  writeJson(inboxPath("p1", "r1"), { id: "r1", workset: "claude-abc", read: false });
  writeJson(inboxPath("p1", "r2"), { id: "r2", workset: "other", read: false });
  renameWorkset("claude-abc", "spike");
  expect(loadWorkset("claude-abc")).toBeNull();
  expect(loadWorkset("spike")).toMatchObject({ name: "spike", sessions: ["claude-1"] });
  expect(Object.fromEntries(listPointers().map((p) => [p.key, p.workset]))).toEqual({ p1: "spike", p2: "spike", p3: "other" });
  expect(existsSync(archiveFile("claude-abc", "x"))).toBe(false);
  expect(readJson(archiveFile("spike", "x"))).toEqual({ id: "x" });
  expect(readJson<{ workset: string }>(inboxPath("p1", "r1"))!.workset).toBe("spike");
  expect(readJson<{ workset: string }>(inboxPath("p1", "r2"))!.workset).toBe("other");
});

test("renameWorkset refuses and moves nothing", () => {
  saveWorkset(createWorkset("a", "hand")); saveWorkset(createWorkset("b", "hand"));
  savePointer(ptr("p1", "a"));
  expect(() => renameWorkset("a", "b")).toThrow('workbench: workset "b" exists');
  expect(() => renameWorkset("a", "Bad Name")).toThrow('workbench: invalid workset name "Bad Name"');
  expect(() => renameWorkset("nope", "c")).toThrow('workbench: no workset "nope"');
  writeJson(lockPath("a"), { workset: "a", review: "r", paths: [], opened: "t", holder: "h" });
  expect(() => renameWorkset("a", "c")).toThrow('workbench: "a" has an open review; close or submit it first');
  expect(existsSync(lockPath("a"))).toBe(true);
  expect(loadWorkset("a")!.name).toBe("a");
  expect(loadWorkset("c")).toBeNull();
  expect(listPointers()[0].workset).toBe("a");
});
