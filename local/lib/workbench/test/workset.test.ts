import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkset, loadWorkset, addMember, saveWorkset, listWorksets, removeMember } from "../src/workset";

beforeEach(() => { process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-state-")); });

test("create, add member, reload", () => {
  const ws = createWorkset("spike");
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
  const ws = createWorkset("spike");
  addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: null, added_by: "hand" });
  addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: "/r/.worktrees/b", added_by: "claude-1" });
  expect(ws.members).toHaveLength(1);
  expect(ws.members[0].worktree).toBe("/r/.worktrees/b");
});

test("a branch declared by path and recorded by slug is one member", () => {
  const ws = createWorkset("spike");
  addMember(ws, { repo: "/r", slug: null, branch: "b", added_by: "hand" });
  addMember(ws, { repo: "/r", slug: "o/r", branch: "b", worktree: "/r/.worktrees/b", added_by: "claude-1" });
  expect(ws.members).toHaveLength(1);
  expect(ws.members[0]).toMatchObject({ id: "/r#b", worktree: "/r/.worktrees/b" });
});

test("remove member", () => {
  const ws = createWorkset("spike");
  const m = addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: null, added_by: "hand" });
  removeMember(ws, m.id);
  expect(ws.members).toHaveLength(0);
});

test("invalid name rejected", () => {
  expect(() => createWorkset("bad name!")).toThrow();
});

test("paths persist on a member, and an empty list means none", () => {
  const ws = createWorkset("spike");
  addMember(ws, { repo: "/r", slug: null, branch: "a", paths: ["docs/", "README.md"], added_by: "hand" });
  addMember(ws, { repo: "/r", slug: null, branch: "b", paths: [], added_by: "hand" });
  saveWorkset(ws);
  const back = loadWorkset("spike")!;
  expect(back.members[0].paths).toEqual(["docs/", "README.md"]);
  expect(back.members[1].paths).toBeNull();
});
