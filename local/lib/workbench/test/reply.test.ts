import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Comment, Reply } from "../src/comments";
import { run as replyCli } from "../src/cmd/reply";
import { addReply, rehydrateReplies } from "../src/reply";
import { archiveFile, openReview, type Review } from "../src/review";
import { drainRecorded } from "../src/spawn";
import { readJson, writeJson } from "../src/store";
import { inboxFile, type ReviewFile } from "../src/submit";
import { addMember, createWorkset, saveWorkset, type Member } from "../src/workset";

const KEYS = ["WORKBENCH_CONFIG", "WORKBENCH_STATE_DIR", "WORKBENCH_DRY_RUN", "WORKBENCH_DRY_RUN_TMUX", "WORKBENCH_DRY_RUN_FAIL",
  "WORKBENCH_DRY_RUN_HUNK_SESSIONS", "WORKBENCH_DRY_RUN_HUNK_NOTES", "WORKBENCH_SESSION", "CLAUDE_CODE_SESSION_ID"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let tmp: string;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wb-reply-")));
  process.env.WORKBENCH_STATE_DIR = join(tmp, "state");
  process.env.WORKBENCH_CONFIG = join(tmp, "config.toml");
  process.env.WORKBENCH_DRY_RUN = "1";
  writeFileSync(join(tmp, "config.toml"), `repo_roots = []\ndefault_branch = "main"\n`);
  drainRecorded();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const KEY = "claude-a", MEMBER = "/r#feat", SID = "sess-1";
const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id, member: MEMBER, repo: "/r", slug: null, branch: "feat", path: "src/x.ts", line: { side: "new", start: 12, end: 14 },
  sha: "abc", type: "question", text: "why this?", replies: [], ...over,
});
const reviewFile = (id: string, comments: Comment[]): ReviewFile => ({
  id, workset: "ws1", submitted: "2026-10-10T10:00:00.000Z", message: null, comments, edits: [], failed: [], sessions: [KEY],
});
function deliver(f: ReviewFile) {
  writeJson(inboxFile(KEY, f.id), { ...f, read: true });
  writeJson(archiveFile(f.workset, f.id), f);
}
const inboxCopy = (id: string) => readJson<ReviewFile>(inboxFile(KEY, id))!;
const archiveCopy = (id: string) => readJson<ReviewFile>(archiveFile("ws1", id))!;
const openFile = (over: Partial<Review> = {}): Review => ({
  id: "r-open", workset: "ws1", opened: "2026-10-10T12:00:00.000Z", snapshot: {}, locked: [], current: MEMBER,
  hunkPaneId: "%1", hunkSessionId: SID, hunkPaneCwd: "/r", ...over,
});
const putOpen = (r: Review) => writeJson(join(tmp, "state", "reviews", "ws1.json"), r);
const liveSessions = (...ids: string[]) => {
  process.env.WORKBENCH_DRY_RUN_HUNK_SESSIONS = JSON.stringify({ sessions: ids.map((sessionId) => ({ sessionId, terminal: { locations: [{ source: "tmux", paneId: "%1" }] } })) });
};
const liveNotes = (...noteIds: string[]) => {
  process.env.WORKBENCH_DRY_RUN_HUNK_NOTES = JSON.stringify({ comments: noteIds.map((noteId) => ({ noteId, source: "user", filePath: "src/x.ts", newRange: [12, 14], body: "x" })) });
};
const adds = () => drainRecorded().filter((c) => c.startsWith("hunk session comment add"));

test("reply appends {at, by, text} to the comment in both the inbox and the archive copy", () => {
  deliver(reviewFile("rv1", [comment("user:1"), comment("user:2")]));
  const { reply, shown } = addReply(KEY, "rv1", "user:2", "because of X");
  expect(shown).toBe(false);
  expect(reply.by).toBe(KEY);
  expect(reply.text).toBe("because of X");
  expect(Number.isNaN(Date.parse(reply.at))).toBe(false);
  for (const f of [inboxCopy("rv1"), archiveCopy("rv1")]) {
    expect(f.comments[0].replies).toEqual([]);
    expect(f.comments[1].replies).toEqual([{ at: reply.at, by: KEY, text: "because of X" }]);
  }
  addReply(KEY, "rv1", "user:2", "and Y");
  expect(archiveCopy("rv1").comments[1].replies.map((r) => r.text)).toEqual(["because of X", "and Y"]);
  expect(inboxCopy("rv1").comments[1].replies.map((r) => r.text)).toEqual(["because of X", "and Y"]);
  expect((readJson<{ read: boolean }>(inboxFile(KEY, "rv1")))!.read).toBe(true);
});

test("reply records no shown_in and issues no hunk comment without a matching, live review window", () => {
  deliver(reviewFile("rv1", [comment("user:1")]));
  liveSessions(SID);
  const cases: (() => void)[] = [
    () => {},                                                   // no open review
    () => putOpen(openFile({ current: "/r#other" })),           // another member is in the reviewer
    () => { putOpen(openFile()); liveSessions("sess-other"); }, // the hunk session is gone
    () => putOpen(openFile({ hunkSessionId: null })),           // no session was ever registered
  ];
  for (const setup of cases) {
    setup();
    drainRecorded();
    expect(addReply(KEY, "rv1", "user:1", "noted").shown).toBe(false);
    expect(adds()).toEqual([]);
  }
  for (const f of [inboxCopy("rv1"), archiveCopy("rv1")]) {
    expect(f.comments[0].replies).toHaveLength(4);
    expect(f.comments[0].replies.every((r) => r.shown_in === undefined)).toBe(true);
  }
});

test("reply with a live window on the comment's member shows it as a hunk reply and records shown_in", () => {
  deliver(reviewFile("rv1", [comment("user:1")]));
  putOpen(openFile());
  liveSessions(SID);
  liveNotes("user:1");
  const { shown } = addReply(KEY, "rv1", "user:1", "fixed in abc1234");
  expect(shown).toBe(true);
  expect(adds()).toEqual([`hunk session comment add ${SID} --reply-to user:1 --summary ↩ fixed in abc1234 --author ${KEY} --json`]);
  for (const f of [inboxCopy("rv1"), archiveCopy("rv1")]) expect(f.comments[0].replies[0].shown_in).toEqual([SID]);
});

test("rehydrate shows exactly the replies not yet shown in this hunk session and records it in the archive", () => {
  const reps: Reply[] = [
    { at: "2026-10-10T11:00:00.000Z", by: KEY, text: "old", shown_in: [SID] },
    { at: "2026-10-10T11:01:00.000Z", by: KEY, text: "new", shown_in: ["sess-0"] },
  ];
  deliver(reviewFile("rv1", [comment("user:1", { replies: reps }), comment("user:9", { member: "/r#other", replies: [{ at: "t", by: KEY, text: "elsewhere" }] })]));
  liveNotes("user:1");
  const m = { id: MEMBER } as Member;
  rehydrateReplies(openFile(), m);
  expect(adds()).toEqual([`hunk session comment add ${SID} --reply-to user:1 --summary ↩ new --author ${KEY} --json`]);
  for (const f of [archiveCopy("rv1"), inboxCopy("rv1")]) {
    expect(f.comments[0].replies.map((r) => r.shown_in)).toEqual([[SID], ["sess-0", SID]]);
    expect(f.comments[1].replies[0].shown_in).toBeUndefined();
  }
  rehydrateReplies(openFile(), m);
  expect(adds()).toEqual([]);
  rehydrateReplies(openFile({ hunkSessionId: null }), m);
  expect(drainRecorded()).toEqual([]);
});

test("rehydrate anchors to the comment's file and line when the user note is not live", () => {
  deliver(reviewFile("rv1", [
    comment("user:1", { replies: [{ at: "t1", by: KEY, text: "done" }] }),
    comment("user:2", { line: { side: "old", start: 7, end: 7 }, text: "drop it", replies: [{ at: "t2", by: KEY, text: "dropped" }] }),
  ]));
  rehydrateReplies(openFile(), { id: MEMBER } as Member);
  expect(adds()).toEqual([
    `hunk session comment add ${SID} --file src/x.ts --new-line 12 --summary ↩ done --rationale re: why this? --author ${KEY} --json`,
    `hunk session comment add ${SID} --file src/x.ts --old-line 7 --summary ↩ dropped --rationale re: drop it --author ${KEY} --json`,
  ]);
  expect(archiveCopy("rv1").comments.map((c) => c.replies[0].shown_in)).toEqual([[SID], [SID]]);
});

test("opening a review rehydrates replies once the hunk session registers", () => {
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "f.txt"), "a\n"); git("add", "f.txt"); git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feat");
  const ws = createWorkset("ws1", "hand");
  const m = addMember(ws, { repo, branch: "feat", worktree: repo, added_by: "hand" });
  saveWorkset(ws);
  deliver({ ...reviewFile("rv1", [comment("user:1", { member: m.id, replies: [{ at: "t1", by: KEY, text: "done" }] })]) });
  liveSessions(SID);
  const r = openReview("ws1", { allowDirty: true });
  expect(r.hunkSessionId).toBe(SID);
  expect(r.commands!.filter((c) => c.startsWith("hunk session comment add"))).toEqual([
    `hunk session comment add ${SID} --file src/x.ts --new-line 12 --summary ↩ done --rationale re: why this? --author ${KEY} --json`,
  ]);
  expect(archiveCopy("rv1").comments[0].replies[0].shown_in).toEqual([SID]);
});

test("the reply command exits 1 for an unknown review or comment and 2 without its flags", async () => {
  deliver(reviewFile("rv1", [comment("user:1")]));
  process.env.WORKBENCH_SESSION = KEY;
  const err: string[] = [];
  const orig = console.error, origLog = console.log;
  console.error = (s: string) => { err.push(s); };
  console.log = () => {};
  try {
    expect(await replyCli(["--review", "nope", "--comment", "user:1", "--text", "x"])).toBe(1);
    expect(err.at(-1)).toContain('no review "nope"');
    expect(await replyCli(["--review", "rv1", "--comment", "user:404", "--text", "x"])).toBe(1);
    expect(err.at(-1)).toContain('no comment "user:404"');
    expect(await replyCli(["--review", "rv1", "--comment", "user:1"])).toBe(2);
    expect(await replyCli(["--review", "rv1", "--comment", "user:1", "--text", "ok"])).toBe(0);
  } finally { console.error = orig; console.log = origLog; }
  expect(archiveCopy("rv1").comments[0].replies.map((r) => r.text)).toEqual(["ok"]);
});
