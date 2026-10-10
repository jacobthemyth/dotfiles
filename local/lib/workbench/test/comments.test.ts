import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseNotes, parseSigil } from "../src/comments";

const fixture = join(import.meta.dir, "fixtures", "hunk-user-notes.json");

test("sigils", () => {
  expect(parseSigil("? why two secrets")).toEqual({ type: "question", text: "why two secrets" });
  expect(parseSigil("// fine")).toMatchObject({ type: "note" });
  expect(parseSigil("// fine")).toEqual({ type: "note", text: "fine" });
  expect(parseSigil("rename this")).toMatchObject({ type: "change" });
  expect(parseSigil("  rename this  ")).toEqual({ type: "change", text: "rename this" });
});

test("normalise hunk notes fixture", () => {
  const c = normaliseNotes(JSON.parse(readFileSync(fixture, "utf8")));
  expect(c[0]).toMatchObject({ path: expect.any(String), line: { side: "new" } });
  expect(c).toHaveLength(2); // the agent note is ignored
  expect(c[0]).toMatchObject({ id: "user:1791644120301-1", path: "f.txt", line: { side: "new", start: 2, end: 2 }, type: "change", text: "user note text", replies: [] });
  expect(c[1]).toMatchObject({ path: "src/old.ts", line: { side: "old", start: 4, end: 6 }, type: "question", text: "why was this removed" });
});

test("normalise takes a bare array, drops replies and stamps the anchor", () => {
  const raw = JSON.parse(readFileSync(fixture, "utf8")).comments;
  raw.push({ ...raw[0], noteId: "user:9-9", parentId: "user:1791644120301-1", body: "a reply" });
  const anchor = { member: "acme/x#feat", repo: "/r", slug: "acme/x", branch: "feat", sha: "abc" };
  const c = normaliseNotes(raw, anchor);
  expect(c.map((x) => x.id)).toEqual(["user:1791644120301-1", "user:1791644131877-2"]);
  expect(c[0]).toMatchObject(anchor);
});
