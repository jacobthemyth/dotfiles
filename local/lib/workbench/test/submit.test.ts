import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReview, loadReview, loadLock } from "../src/review";
import { savePointer } from "../src/session";
import { closeReview, submitReview, type ReviewFile } from "../src/submit";
import { addMember, createWorkset, saveWorkset } from "../src/workset";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Rev Iewer", GIT_AUTHOR_EMAIL: "r@t", GIT_COMMITTER_NAME: "Rev Iewer", GIT_COMMITTER_EMAIL: "r@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_NAME: "agent" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

let tmp: string, repo: string, logs: string[];
const log = (s: string) => { logs.push(s); };
const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN", "WORKBENCH_DRY_RUN_TMUX", "WORKBENCH_DRY_RUN_FAIL", ...Object.keys(GIT_ENV)];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  logs = [];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-submit-")));
  Object.assign(process.env, GIT_ENV);
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_DRY_RUN = "1";
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
  repo = join(tmp, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), "a\n");
  sh(repo, "add", "f.txt");
  sh(repo, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function worktree(branch: string, base = "main"): string {
  const wt = join(tmp, `wt-${branch}`);
  sh(repo, "worktree", "add", "-q", "-b", branch, wt, base);
  writeFileSync(join(wt, `${branch}.txt`), `${branch}\n`);
  sh(wt, "add", ".");
  sh(wt, "commit", "-q", "-m", branch);
  return wt;
}

function workset(members: { branch: string; worktree: string; base?: string }[], sessions: string[] = []) {
  const ws = createWorkset("ws1", "hand");
  ws.sessions = sessions;
  for (const m of members) addMember(ws, { repo, branch: m.branch, worktree: m.worktree, base: m.base, added_by: "hand" });
  saveWorkset(ws);
  return ws;
}

const pointer = (key: string, closed: string | null = null) =>
  savePointer({ key, harness: "claude", session: key.slice(7), workset: "ws1", cwd: tmp, opened: "2026-10-10T00:00:00Z", closed });
const notesPath = (memberId: string) => join(tmp, "state", "reviews", "ws1", "notes", `${memberId.replace(/[/#]/g, "_")}.json`);
const fixture = readFileSync(join(import.meta.dir, "fixtures", "hunk-user-notes.json"), "utf8");

test("submit commits only files changed since open, one commit per branch, with trailers", async () => {
  const a = worktree("feat");
  const b = worktree("feat2", "feat");
  const c = worktree("feat3", "feat2");
  workset([{ branch: "feat", worktree: a }, { branch: "feat2", worktree: b, base: "feat" }, { branch: "feat3", worktree: c, base: "feat2" }]);
  writeFileSync(join(a, "scratch.txt"), "agent wip\n"); // dirty before open: never committed by submit
  writeFileSync(join(a, "feat.txt"), "agent wip\n");
  const r = openReview("ws1", { allowDirty: true });
  const cTip = sh(c, "rev-parse", "HEAD");

  writeFileSync(join(a, "f.txt"), "edited\n");
  writeFileSync(join(a, "new.txt"), "new\n");
  writeFileSync(join(b, "f.txt"), "edited in b\n");
  const out = await submitReview("ws1", { message: "tidy names", log });

  for (const wt of [a, b]) {
    expect(sh(wt, "log", "-1", "--format=%an%n%B")).toBe(`Rev Iewer\ntidy names\n\nWorkset: ws1\nReview: ${r.id}`);
  }
  expect(sh(a, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["f.txt", "new.txt"]);
  expect(sh(b, "show", "--name-only", "--format=", "HEAD")).toBe("f.txt");
  expect(sh(a, "rev-list", "--count", "HEAD")).toBe("3");
  expect(sh(c, "rev-parse", "HEAD")).toBe(cTip); // untouched member: no commit
  expect(sh(a, "status", "--porcelain").split("\n").sort()).toEqual(["?? scratch.txt", "M feat.txt"]); // sh trims the leading space
  expect(out.edits).toEqual([
    { repo, branch: "feat", sha: sh(a, "rev-parse", "HEAD"), files: ["f.txt", "new.txt"] },
    { repo, branch: "feat2", sha: sh(b, "rev-parse", "HEAD"), files: ["f.txt"] },
  ]);
  expect(out.message).toBe("tidy names");
});

test("submit without a message uses the default commit message and records no overall message", async () => {
  const a = worktree("feat");
  workset([{ branch: "feat", worktree: a }]);
  openReview("ws1", { allowDirty: false });
  writeFileSync(join(a, "f.txt"), "edited\n");
  const out = await submitReview("ws1", { log });
  expect(sh(a, "log", "-1", "--format=%s")).toBe("Review edits (workbench)");
  expect(out.message).toBeNull();
});

test("submit writes the review to every bound session's inbox and releases the lock", async () => {
  const a = worktree("feat");
  workset([{ branch: "feat", worktree: a }], ["claude-one", "claude-two", "claude-gone", "claude-missing"]);
  pointer("claude-one");
  pointer("claude-two");
  pointer("claude-gone", "2026-10-10T01:00:00Z");
  const r = openReview("ws1", { allowDirty: false });
  writeFileSync(join(a, "f.txt"), "edited\n");
  const out = await submitReview("ws1", { message: "m", log });

  expect(out.sessions).toEqual(["claude-one", "claude-two"]);
  for (const key of ["claude-one", "claude-two"]) {
    const f = JSON.parse(readFileSync(join(tmp, "state", "inbox", key, `${r.id}.json`), "utf8"));
    expect(f).toMatchObject({ id: r.id, workset: "ws1", read: false, message: "m", sessions: ["claude-one", "claude-two"] });
    expect(f.edits).toHaveLength(1);
  }
  expect(existsSync(join(tmp, "state", "inbox", "claude-gone"))).toBe(false);
  const archive: ReviewFile = JSON.parse(readFileSync(join(tmp, "state", "reviews", "ws1", `${r.id}.json`), "utf8"));
  expect(archive).toMatchObject({ id: r.id, edits: out.edits, sessions: out.sessions });
  expect(loadLock("ws1")).toBeNull();
  expect(loadReview("ws1")).toBeNull();
  expect(logs.join("\n")).toContain("claude-one, claude-two");
});

test("submit skips a member whose worktree vanished", async () => {
  const a = worktree("feat");
  const b = worktree("feat2", "feat");
  workset([{ branch: "feat", worktree: a }, { branch: "feat2", worktree: b, base: "feat" }]);
  openReview("ws1", { allowDirty: false });
  writeFileSync(join(a, "f.txt"), "edited\n");
  rmSync(b, { recursive: true, force: true });
  const out = await submitReview("ws1", { message: "m", log });
  expect(out.edits.map((e) => e.branch)).toEqual(["feat"]);
  expect(logs.join("\n")).toContain(`skipping ${repo}#feat2: worktree ${b} is gone`);
  expect(loadLock("ws1")).toBeNull();
});

test("submit with no live hunk session treats comments as empty", async () => {
  const a = worktree("feat");
  workset([{ branch: "feat", worktree: a }]);
  openReview("ws1", { allowDirty: false });
  const out = await submitReview("ws1", { message: "m", log });
  expect(out.comments).toEqual([]);
  expect(out.edits).toEqual([]);
  expect(logs.join("\n")).toContain("0 change, 0 question, 0 note");
});

test("submit collects snapshotted notes of a non-current member, anchored to its post-edit sha", async () => {
  const a = worktree("feat");
  const b = worktree("feat2", "feat");
  workset([{ branch: "feat", worktree: a }, { branch: "feat2", worktree: b, base: "feat" }]);
  openReview("ws1", { allowDirty: false }); // current is feat
  const id = `${repo}#feat2`;
  mkdirSync(join(notesPath(id), ".."), { recursive: true });
  writeFileSync(notesPath(id), JSON.stringify(JSON.parse(fixture).comments));
  writeFileSync(join(b, "f.txt"), "edited\n");
  const out = await submitReview("ws1", { message: "m", log });
  const sha = sh(b, "rev-parse", "HEAD");
  expect(out.comments).toHaveLength(2);
  expect(out.comments.map((c) => [c.member, c.branch, c.type, c.sha])).toEqual([[id, "feat2", "change", sha], [id, "feat2", "question", sha]]);
  expect(out.edits[0].sha).toBe(sha);
  expect(logs.join("\n")).toContain("1 change, 1 question, 0 note");
});

test("close releases the lock and keeps the review file for rehydration", () => {
  const a = worktree("feat");
  workset([{ branch: "feat", worktree: a }]);
  const r = openReview("ws1", { allowDirty: false });
  writeFileSync(join(a, "f.txt"), "edited\n");
  expect(closeReview("ws1")).toBe(r.id);
  expect(loadLock("ws1")).toBeNull();
  expect(loadReview("ws1")).toBeNull();
  expect(existsSync(notesPath(`${repo}#feat`))).toBe(true);
  expect(readdirSync(join(tmp, "state", "reviews", "ws1"))).toContain("notes");
  expect(sh(a, "status", "--porcelain")).toBe("M f.txt"); // close commits nothing
  expect(() => closeReview("ws1")).toThrow(/no open review/);
});

test("submit refuses without an open review or workset", async () => {
  expect(submitReview("nope", { log })).rejects.toThrow(/no workset "nope"/);
  workset([{ branch: "feat", worktree: worktree("feat") }]);
  expect(submitReview("ws1", { log })).rejects.toThrow(/no open review/);
});

test("a failed commit is reported, the member skipped and submit carries on", async () => {
  const a = worktree("feat");
  workset([{ branch: "feat", worktree: a }], ["claude-one"]);
  pointer("claude-one");
  openReview("ws1", { allowDirty: false });
  writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(a, "f.txt"), "edited\n");
  const out = await submitReview("ws1", { message: "m", log });
  expect(out.edits).toEqual([]);
  expect(logs.join("\n")).toContain(`commit failed for ${repo}#feat`);
  expect(out.sessions).toEqual(["claude-one"]);
  expect(loadLock("ws1")).toBeNull();
});

test("close still releases the lock when the workset file is gone", () => {
  workset([{ branch: "feat", worktree: worktree("feat") }]);
  openReview("ws1", { allowDirty: false });
  rmSync(join(tmp, "state", "worksets", "ws1.json"));
  closeReview("ws1");
  expect(loadLock("ws1")).toBeNull();
});
