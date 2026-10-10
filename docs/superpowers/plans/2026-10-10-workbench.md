# workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bun/TypeScript CLI `workbench` that records what agent sessions produce into worksets, opens a tmux review window (sidebar plus hunk) over a workset, and hands batched comments and committed edits back to the bound Claude Code sessions through hooks.

**Architecture:** One CLI with subcommand groups (`workset`, `hook`, `open`, `submit`, `close`, `inbox`, `reply`, `scan`). State is JSON files under an XDG state dir; config is TOML under an XDG config dir. A harness adapter (`harness/claude.ts`) translates Claude Code hook stdin into generic events handled by `hook.ts`; nothing else knows about Claude. The review window is tmux plus hunk's daemon CLI; the sidebar is a small raw-mode TUI.

**Tech Stack:** Bun (TypeScript, `bun test`, `Bun.spawnSync`, `Bun.TOML`), git, gh, tmux, hunk ≥ 0.23.0, neovim via `$EDITOR`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-workbench-design.md`. Glossary: `local/lib/workbench/CONTEXT.md`.

## Global Constraints

- Code lives at `local/lib/workbench/` (rcm → `~/.local/lib/workbench`); shim at `local/bin/workbench`; config at `config/workbench/config.toml` (rcm → `~/.config/workbench/config.toml`). Add `local/lib/workbench config/workbench` to `SYMLINK_DIRS` in `rcrc`.
- No path is hard-coded in `src/`. Paths come from `XDG_STATE_HOME` (default `~/.local/state`), `XDG_CONFIG_HOME` (default `~/.config`), and config.toml. Tests set `WORKBENCH_STATE_DIR` and `WORKBENCH_CONFIG` to temp paths.
- State files: `worksets/<name>.json`, `sessions/<harness>-<id>.json`, `inbox/<harness>-<id>/<review-id>.json`, `locks/<workset>.json`, `watch/<harness>-<id>.pid`. Writes are atomic (temp file plus rename).
- Roles are exactly `work` and `throwaway`. Comment types are exactly `change`, `question`, `note`. Sigils: `?` → question, `//` → note, else change.
- Never amend, rebase or fixup any existing commit. Submit stages only files changed since open and commits with `--trailer "Workset: <name>" --trailer "Review: <id>"`.
- Never run `terraform`, never push, never post to GitHub. `gh` is read-only in v1 (`pr list`, `pr view`, `repo view`).
- Hook commands must finish fast: no network in PreToolUse. Only `PostToolUse` may call `gh`, and only after a recognised command.
- Vocabulary in code, docs and messages follows `CONTEXT.md`: workset, member, role, unclaimed, harness, session, pointer, adapter, review, comment, edit, lock, submit, close, inbox, reply, reviewer, sidebar, review window. Never "orphan", "stack" for the whole thing, or "ledger".
- Commits in this repo are small and named `workbench: <what>`; stage by name.

## Review Focus

1. A locked path given to Edit as a relative path, or a Bash command that `cd`s into a locked worktree before writing: the deny must still fire (Task 8 tests resolve paths against `cwd` and scan for `cd <path> &&`).
2. Two Claude sessions bound to one workset submit-time: the review must land in both inboxes and both watchers must wake (Task 10 test writes two pointers).
3. A member whose PR was merged and branch deleted between open and submit: submit must skip it with a message, not crash on `git rev-parse` (Task 9 test removes the worktree).
4. `hunk session comment list` returning zero notes for a member that was never selected (no live session for that worktree): submit must treat it as no comments, not an error (Task 9 test stubs an empty JSON).
5. SessionStart with `source: "compact"` or `"resume"`: the pointer must not be recreated bound to a fresh default workset, losing the binding (Task 3 test reuses the existing pointer).

---

### Task 1: Scaffold, shim, config

**Files:**
- Modify: `rcrc` (SYMLINK_DIRS)
- Create: `local/lib/workbench/package.json`, `tsconfig.json`, `src/cli.ts`, `src/paths.ts`, `src/config.ts`, `test/config.test.ts`
- Create: `local/bin/workbench`, `config/workbench/config.toml`
- Modify: `aliases` (add `wb`)

**Interfaces:**
- Produces: `paths.stateDir(): string`, `paths.configPath(): string`, `loadConfig(): Config` where `Config = { repo_roots: string[]; worktree_dirs: string[]; exclude_repos: string[]; github_user: string; harnesses: string[]; default_branch: string }`.

- [ ] **Step 1: Install runtimes**

```bash
brew install oven-sh/bun/bun && brew upgrade hunk && bun --version && hunk --version
```
Expected: bun 1.x, hunk 0.23.0 or later. Re-read `hunk session --help` and note any change from the 0.19.0 usage recorded in the spec.

- [ ] **Step 2: rcm and layout**

In `rcrc` change:
```sh
export SYMLINK_DIRS="agents/skills/* local/lib/papersync config/papersync local/lib/workbench config/workbench"
```
Create `local/bin/workbench`:
```sh
#!/bin/sh
exec bun run "$HOME/.local/lib/workbench/src/cli.ts" "$@"
```
`chmod +x local/bin/workbench`. Append to `aliases`: `alias wb=workbench`.

Create `config/workbench/config.toml`:
```toml
# Workbench: what agents produced, reviewed in one place. See ~/.local/lib/workbench/CONTEXT.md.
repo_roots = ["~/Code/abridgeai/*", "~/.dotfiles"]
worktree_dirs = [".worktrees", "/tmp/worktrees", "~/.claude/worktrees"]
exclude_repos = ["~/Code/abridgeai/kp-production-readiness"]
github_user = "@me"
harnesses = ["claude"]
default_branch = "main"
```

- [ ] **Step 3: Project files**

`local/lib/workbench/package.json`:
```json
{
  "name": "workbench",
  "private": true,
  "type": "module",
  "scripts": { "test": "bun test", "check": "bun x tsc --noEmit" }
}
```
`tsconfig.json`:
```json
{ "compilerOptions": { "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler", "strict": true, "types": ["bun-types"], "noEmit": true } }
```
Run `bun add -d bun-types typescript` (dev only; commit `bun.lock`).

- [ ] **Step 4: Failing config test**

`test/config.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

test("loads config and expands ~ in roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, 'repo_roots = ["~/Code/x/*"]\nworktree_dirs = [".worktrees"]\nexclude_repos = []\ngithub_user = "@me"\nharnesses = ["claude"]\ndefault_branch = "main"\n');
  process.env.WORKBENCH_CONFIG = p;
  const c = loadConfig();
  expect(c.repo_roots[0]).toBe(join(process.env.HOME!, "Code/x/*"));
  expect(c.default_branch).toBe("main");
});

test("missing config fails with the path in the message", () => {
  process.env.WORKBENCH_CONFIG = "/nonexistent/config.toml";
  expect(() => loadConfig()).toThrow("/nonexistent/config.toml");
});
```
Run: `cd local/lib/workbench && bun test` → FAIL (module not found).

- [ ] **Step 5: paths and config**

`src/paths.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p === "~" ? homedir() : p;
}
export function stateDir(): string {
  return process.env.WORKBENCH_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "workbench");
}
export function configPath(): string {
  return process.env.WORKBENCH_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "workbench/config.toml");
}
export const sub = (name: string) => join(stateDir(), name);
```
`src/config.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { configPath, expandHome } from "./paths";

export type Config = {
  repo_roots: string[]; worktree_dirs: string[]; exclude_repos: string[];
  github_user: string; harnesses: string[]; default_branch: string;
};

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) throw new Error(`workbench: config not found at ${p}`);
  const raw = Bun.TOML.parse(readFileSync(p, "utf8")) as Partial<Config>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map(expandHome) : []);
  return {
    repo_roots: list(raw.repo_roots),
    worktree_dirs: list(raw.worktree_dirs),
    exclude_repos: list(raw.exclude_repos),
    github_user: raw.github_user ?? "@me",
    harnesses: Array.isArray(raw.harnesses) ? raw.harnesses.map(String) : ["claude"],
    default_branch: raw.default_branch ?? "main",
  };
}
```
`src/cli.ts` (dispatcher, grows per task):
```ts
#!/usr/bin/env bun
const [group, ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<(args: string[]) => Promise<number>>> = {
  config: async () => (await import("./cmd/config")).run,
};
const load = commands[group ?? ""];
if (!load) { console.error("usage: workbench <config|workset|hook|scan|open|submit|close|inbox|reply> ..."); process.exit(2); }
process.exit(await (await load())(rest));
```
`src/cmd/config.ts`:
```ts
import { loadConfig } from "../config";
export async function run(_: string[]) { console.log(JSON.stringify(loadConfig(), null, 2)); return 0; }
```
Run `bun test` → PASS. Run `rcup` then `workbench config` → prints the expanded config.

- [ ] **Step 6: Commit**

```bash
git add rcrc aliases local/bin/workbench config/workbench/config.toml local/lib/workbench/package.json local/lib/workbench/tsconfig.json local/lib/workbench/bun.lock local/lib/workbench/src local/lib/workbench/test
git commit -m "workbench: scaffold, shim, config"
```

---

### Task 2: Store and workset manifest

**Files:**
- Create: `src/store.ts`, `src/workset.ts`, `src/cmd/workset.ts`, `test/workset.test.ts`
- Modify: `src/cli.ts` (add `workset`)

**Interfaces:**
- Produces:
```ts
type Role = "work" | "throwaway";
type Member = { id: string; repo: string; slug: string | null; branch: string; worktree: string | null;
  base: string | null; pr: { number: number; url: string; draft: boolean; state: string } | null;
  order: number | null; role: Role; added_by: string; added_at: string };
type Workset = { name: string; created: string; members: Member[]; sessions: string[]; ignored: string[] };
readJson<T>(path): T | null; writeJson(path, value); listJson(dir): string[]
loadWorkset(name): Workset | null; saveWorkset(ws); createWorkset(name, by); addMember(ws, partial): Member; removeMember(ws, id)
```
- Member `id` is `${slug ?? repo}#${branch}`.

- [ ] **Step 1: Failing tests**

`test/workset.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkset, loadWorkset, addMember, saveWorkset, listWorksets, removeMember } from "../src/workset";

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

test("remove member", () => {
  const ws = createWorkset("spike", "hand");
  const m = addMember(ws, { repo: "/r", slug: null, branch: "b", worktree: null, added_by: "hand" });
  removeMember(ws, m.id);
  expect(ws.members).toHaveLength(0);
});

test("invalid name rejected", () => {
  expect(() => createWorkset("bad name!", "hand")).toThrow();
});
```
Run → FAIL.

- [ ] **Step 2: Implement store and workset**

`src/store.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
export function removeFile(path: string): void { if (existsSync(path)) unlinkSync(path); }
export function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).sort();
}
export const now = () => new Date().toISOString();
```
`src/workset.ts`:
```ts
import { join } from "node:path";
import { sub } from "./paths";
import { readJson, writeJson, listJson, now, removeFile } from "./store";

export type Role = "work" | "throwaway";
export type Pr = { number: number; url: string; draft: boolean; state: string };
export type Member = {
  id: string; repo: string; slug: string | null; branch: string; worktree: string | null;
  base: string | null; pr: Pr | null; order: number | null; role: Role; added_by: string; added_at: string;
};
export type Workset = { name: string; created: string; members: Member[]; sessions: string[]; ignored: string[] };

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const dir = () => sub("worksets");
const file = (name: string) => join(dir(), `${name}.json`);

export function memberId(m: { slug: string | null; repo: string; branch: string }) { return `${m.slug ?? m.repo}#${m.branch}`; }
export function listWorksets(): string[] { return listJson(dir()); }
export function loadWorkset(name: string): Workset | null { return readJson<Workset>(file(name)); }
export function saveWorkset(ws: Workset): void { writeJson(file(ws.name), ws); }
export function deleteWorkset(name: string): void { removeFile(file(name)); }
export function createWorkset(name: string, by: string): Workset {
  if (!NAME.test(name)) throw new Error(`workbench: invalid workset name "${name}"`);
  if (loadWorkset(name)) throw new Error(`workbench: workset "${name}" exists`);
  const ws: Workset = { name, created: now(), members: [], sessions: by.startsWith("hand") ? [] : [by], ignored: [] };
  saveWorkset(ws);
  return ws;
}
export type MemberInput = Partial<Omit<Member, "id" | "added_at">> & Pick<Member, "repo" | "branch" | "added_by">;
export function addMember(ws: Workset, input: MemberInput): Member {
  const slug = input.slug ?? null;
  const id = memberId({ slug, repo: input.repo, branch: input.branch });
  const existing = ws.members.find((m) => m.id === id);
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null)));
    return existing;
  }
  const m: Member = {
    id, repo: input.repo, slug, branch: input.branch, worktree: input.worktree ?? null, base: input.base ?? null,
    pr: input.pr ?? null, order: input.order ?? null, role: input.role ?? "work", added_by: input.added_by, added_at: now(),
  };
  ws.members.push(m);
  return m;
}
export function removeMember(ws: Workset, id: string): void { ws.members = ws.members.filter((m) => m.id !== id); }
```
Run → PASS.

- [ ] **Step 3: CLI**

`src/cmd/workset.ts` with subcommands `list`, `show <name>`, `create <name>`, `add <name> --repo <path> --branch <b> [--worktree <p>] [--base <ref>] [--order <n>] [--role work|throwaway]`, `rm <name> <member-id>`, `use <name>` (Task 3 fills `use`). Use `util.parseArgs` with `allowPositionals: true`. `show` prints members as a table: order, role, slug#branch, worktree, pr. Register in `cli.ts`: `workset: async () => (await import("./cmd/workset")).run`.

Manual check: `workbench workset create spike && workbench workset add spike --repo ~/Code/abridgeai/infrastructure --branch jakesmith/service-module-spike --worktree ~/Code/abridgeai/infrastructure/.worktrees/service-module-spike && workbench workset show spike`.

- [ ] **Step 4: Commit** — `git commit -m "workbench: workset manifest and commands"`.

---

### Task 3: Session pointer and the Claude adapter

**Files:**
- Create: `src/session.ts`, `src/events.ts`, `src/harness/claude.ts`, `src/hook.ts`, `src/cmd/hook.ts`, `test/claude-adapter.test.ts`, `test/session.test.ts`
- Modify: `src/cli.ts`, `src/cmd/workset.ts` (`use`), `claude/settings.json`

**Interfaces:**
- Produces:
```ts
type Event =
  | { kind: "sessionStarted"; harness: string; session: string; cwd: string; resumed: boolean }
  | { kind: "sessionEnded"; harness: string; session: string }
  | { kind: "beforeWrite"; harness: string; session: string; cwd: string; path: string; tool: string }
  | { kind: "beforeCommand"; harness: string; session: string; cwd: string; command: string }
  | { kind: "afterCommand"; harness: string; session: string; cwd: string; command: string; output: string }
  | { kind: "promptSubmitted"; harness: string; session: string; cwd: string }
  | { kind: "turnEnded"; harness: string; session: string };
type Outcome = { deny?: string; context?: string };
parseClaudeHook(stdin: unknown): Event | null; renderClaudeOutcome(event, outcome): string
type Pointer = { key: string; harness: string; session: string; workset: string; cwd: string; opened: string; closed: string | null };
pointerKey(harness, session); loadPointer(key); savePointer(p); bindSession(key, workset); currentWorkset(key): string | null
handle(event: Event): Outcome
```

- [ ] **Step 1: Failing adapter tests**

`test/claude-adapter.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseClaudeHook } from "../src/harness/claude";

const base = { session_id: "abc", cwd: "/w", transcript_path: "/t" };

test("PreToolUse Edit becomes beforeWrite with the file path", () => {
  const e = parseClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/w/a.ts" } });
  expect(e).toEqual({ kind: "beforeWrite", harness: "claude", session: "abc", cwd: "/w", path: "/w/a.ts", tool: "Edit" });
});
test("PreToolUse Bash becomes beforeCommand", () => {
  const e = parseClaudeHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
  expect(e?.kind).toBe("beforeCommand");
});
test("PostToolUse Bash carries output", () => {
  const e = parseClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { stdout: "https://github.com/o/r/pull/7\n" } });
  expect(e).toMatchObject({ kind: "afterCommand", output: expect.stringContaining("pull/7") });
});
test("SessionStart resume is flagged", () => {
  expect(parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "resume" })).toMatchObject({ kind: "sessionStarted", resumed: true });
  expect(parseClaudeHook({ ...base, hook_event_name: "SessionStart", source: "startup" })).toMatchObject({ resumed: false });
});
test("unknown events are null", () => {
  expect(parseClaudeHook({ ...base, hook_event_name: "Notification" })).toBeNull();
});
```
`test/session.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/hook";
import { loadPointer, pointerKey } from "../src/session";
import { loadWorkset } from "../src/workset";

beforeEach(() => { process.env.WORKBENCH_STATE_DIR = mkdtempSync(join(tmpdir(), "wb-")); });

test("session start creates a pointer and a default workset", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  const p = loadPointer(pointerKey("claude", "abc"))!;
  expect(p.workset).toBe("claude-abc");
  expect(loadWorkset("claude-abc")).not.toBeNull();
});
test("resume keeps an existing binding", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  const { bindSession, pointerKey: pk } = require("../src/session");
  bindSession(pk("claude", "abc"), "spike");
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: true });
  expect(loadPointer(pk("claude", "abc"))!.workset).toBe("spike");
});
test("session end closes the pointer and deletes an empty default workset", () => {
  handle({ kind: "sessionStarted", harness: "claude", session: "abc", cwd: "/w", resumed: false });
  handle({ kind: "sessionEnded", harness: "claude", session: "abc" });
  expect(loadPointer(pointerKey("claude", "abc"))!.closed).not.toBeNull();
  expect(loadWorkset("claude-abc")).toBeNull();
});
```
Run → FAIL.

- [ ] **Step 2: Implement**

`src/events.ts`: the `Event` and `Outcome` types above.

`src/harness/claude.ts`:
```ts
import type { Event, Outcome } from "../events";

type In = Record<string, any>;
export function parseClaudeHook(i: unknown): Event | null {
  const h = i as In; const s = { harness: "claude", session: String(h.session_id ?? ""), cwd: String(h.cwd ?? "") };
  switch (h.hook_event_name) {
    case "SessionStart": return { kind: "sessionStarted", ...s, resumed: h.source !== "startup" && h.source !== "clear" };
    case "SessionEnd": return { kind: "sessionEnded", harness: s.harness, session: s.session };
    case "UserPromptSubmit": return { kind: "promptSubmitted", ...s };
    case "Stop": return { kind: "turnEnded", harness: s.harness, session: s.session };
    case "PreToolUse":
      if (h.tool_name === "Bash") return { kind: "beforeCommand", ...s, command: String(h.tool_input?.command ?? "") };
      if (["Edit", "Write", "NotebookEdit"].includes(h.tool_name)) return { kind: "beforeWrite", ...s, path: String(h.tool_input?.file_path ?? h.tool_input?.notebook_path ?? ""), tool: h.tool_name };
      return null;
    case "PostToolUse":
      if (h.tool_name !== "Bash") return null;
      const r = h.tool_response; const out = typeof r === "string" ? r : [r?.stdout, r?.stderr].filter(Boolean).join("\n");
      return { kind: "afterCommand", ...s, command: String(h.tool_input?.command ?? ""), output: out ?? "" };
    default: return null;
  }
}
export function renderClaudeOutcome(e: Event, o: Outcome): string {
  const name = { beforeWrite: "PreToolUse", beforeCommand: "PreToolUse", sessionStarted: "SessionStart", promptSubmitted: "UserPromptSubmit", afterCommand: "PostToolUse" }[e.kind as string];
  if (!name) return "";
  const out: any = { hookSpecificOutput: { hookEventName: name } };
  if (o.deny && name === "PreToolUse") { out.hookSpecificOutput.permissionDecision = "deny"; out.hookSpecificOutput.permissionDecisionReason = o.deny; }
  if (o.context) out.hookSpecificOutput.additionalContext = o.context;
  return Object.keys(out.hookSpecificOutput).length > 1 ? JSON.stringify(out) : "";
}
```
`src/session.ts`:
```ts
import { join } from "node:path";
import { sub } from "./paths";
import { readJson, writeJson, now, listJson } from "./store";

export type Pointer = { key: string; harness: string; session: string; workset: string; cwd: string; opened: string; closed: string | null };
const dir = () => sub("sessions");
export const pointerKey = (harness: string, session: string) => `${harness}-${session}`;
const file = (key: string) => join(dir(), `${key}.json`);
export const loadPointer = (key: string) => readJson<Pointer>(file(key));
export const savePointer = (p: Pointer) => writeJson(file(p.key), p);
export const listPointers = () => listJson(dir()).map((k) => loadPointer(k)!).filter(Boolean);
export function bindSession(key: string, workset: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  p.workset = workset; savePointer(p); return p;
}
export const currentWorkset = (key: string) => loadPointer(key)?.workset ?? null;
export function openPointer(harness: string, session: string, cwd: string): Pointer {
  const key = pointerKey(harness, session);
  const existing = loadPointer(key);
  if (existing) { existing.closed = null; existing.cwd = cwd; savePointer(existing); return existing; }
  const p: Pointer = { key, harness, session, workset: key, cwd, opened: now(), closed: null };
  savePointer(p); return p;
}
export function closePointer(key: string): Pointer | null {
  const p = loadPointer(key); if (!p) return null; p.closed = now(); savePointer(p); return p;
}
```
`src/hook.ts` (grows in Tasks 4, 8, 10):
```ts
import type { Event, Outcome } from "./events";
import { openPointer, closePointer, pointerKey, loadPointer } from "./session";
import { createWorkset, loadWorkset, deleteWorkset, saveWorkset } from "./workset";

export function handle(e: Event): Outcome {
  switch (e.kind) {
    case "sessionStarted": {
      const p = openPointer(e.harness, e.session, e.cwd);
      let ws = loadWorkset(p.workset);
      if (!ws) { ws = createWorkset(p.workset, p.key); }
      if (!ws.sessions.includes(p.key)) { ws.sessions.push(p.key); saveWorkset(ws); }
      return { context: `workbench: this session is bound to workset "${p.workset}" (change with \`workbench workset use <name>\`).` };
    }
    case "sessionEnded": {
      const p = closePointer(pointerKey(e.harness, e.session));
      if (p && p.workset === p.key) { const ws = loadWorkset(p.workset); if (ws && ws.members.length === 0) deleteWorkset(p.workset); }
      return {};
    }
    default: return {};
  }
}
```
`src/cmd/hook.ts`:
```ts
import { parseClaudeHook, renderClaudeOutcome } from "../harness/claude";
import { handle } from "../hook";
export async function run(args: string[]) {
  const [harness] = args;
  if (harness !== "claude") { console.error("workbench hook: unknown harness"); return 2; }
  const input = JSON.parse(await Bun.stdin.text() || "{}");
  const event = parseClaudeHook(input);
  if (!event) return 0;
  const out = renderClaudeOutcome(event, handle(event));
  if (out) process.stdout.write(out);
  return 0;
}
```
`workset use <name>` in `cmd/workset.ts`: needs the session key; read `WORKBENCH_SESSION` env if set, else `--session <key>`; `bindSession(key, name)` and add key to `ws.sessions`. (Claude Code exposes no session id to Bash by default; the SessionStart context tells the agent its key, and the agent passes `--session claude-<id>`.)

Run tests → PASS.

- [ ] **Step 3: Wire Claude Code hooks**

In `claude/settings.json` add alongside the existing `rtk hook claude` entry (keep that first):
```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "workbench hook claude", "timeout": 10 }] }],
"SessionEnd":   [{ "hooks": [{ "type": "command", "command": "workbench hook claude", "timeout": 10 }] }],
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "workbench hook claude", "timeout": 10 }] }],
"PreToolUse": [ ...existing rtk entry..., { "matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "workbench hook claude", "timeout": 10 }] }],
"PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "workbench hook claude", "timeout": 30 }] }]
```
Verify: start a fresh `claude` session in a scratch directory, exit it, then `ls ~/.local/state/workbench/sessions` shows `claude-<id>.json` with `closed` set. Also dump one real stdin payload per event to a temp file once (`WORKBENCH_HOOK_DEBUG=/tmp/wb-hooks.jsonl` appends raw stdin when set) and compare field names with the adapter; fix any mismatch (SessionEnd and Stop fields are the least certain).

- [ ] **Step 4: Commit** — `git commit -m "workbench: session pointers and the Claude Code adapter"` (include `claude/settings.json`).

---

### Task 4: Auto-recording from agent commands

**Files:**
- Create: `src/record.ts`, `src/git.ts`, `src/gh.ts`, `test/record.test.ts`
- Modify: `src/hook.ts` (`afterCommand`)

**Interfaces:**
- Produces: `recognise(command: string, output: string, cwd: string): Recorded[]` where `Recorded = { kind: "worktree" | "push" | "pr"; path?: string; branch?: string; prUrl?: string }`; `git.repoRoot(cwd)`, `git.currentBranch(cwd)`, `git.remoteSlug(cwd)`, `git.worktrees(repo): { path: string; branch: string | null }[]`, `git.isDirty(path)`, `git.revParse(path, ref)`, `git.defaultBranch(repo)`; `gh.prForBranch(slug, branch): Pr | null`, `gh.prBase(slug, number): string`, `gh.myPrs(slug): PrWithBranch[]`.

- [ ] **Step 1: Failing recogniser tests**

```ts
import { test, expect } from "bun:test";
import { recognise } from "../src/record";

test("git worktree add with -b", () => {
  const r = recognise("/usr/bin/git worktree add .worktrees/x -b feat/x origin/main", "", "/repo");
  expect(r).toEqual([{ kind: "worktree", path: "/repo/.worktrees/x", branch: "feat/x" }]);
});
test("git worktree add detached from a sha has no branch", () => {
  const r = recognise("git worktree add /tmp/worktrees/t 8b5189615f", "", "/repo");
  expect(r[0]).toMatchObject({ kind: "worktree", path: "/tmp/worktrees/t", branch: null });
});
test("git push -u records a push of the branch", () => {
  expect(recognise("git push -u origin feat/x", "", "/repo")[0]).toEqual({ kind: "push", branch: "feat/x" });
  expect(recognise("git push --set-upstream origin feat/y", "", "/repo")[0]).toEqual({ kind: "push", branch: "feat/y" });
});
test("gh pr create takes the url from output", () => {
  const r = recognise("gh pr create --draft --title x", "Creating pull request\nhttps://github.com/o/r/pull/12\n", "/repo");
  expect(r[0]).toEqual({ kind: "pr", prUrl: "https://github.com/o/r/pull/12" });
});
test("compound commands yield several records", () => {
  const r = recognise("git worktree add .worktrees/a -b a && cd .worktrees/a && git push -u origin a", "", "/repo");
  expect(r.map((x) => x.kind)).toEqual(["worktree", "push"]);
});
test("unrelated commands yield nothing", () => {
  expect(recognise("git status", "", "/repo")).toEqual([]);
});
```
Run → FAIL.

- [ ] **Step 2: Implement recogniser**

`src/record.ts`:
```ts
import { isAbsolute, join } from "node:path";
export type Recorded = { kind: "worktree"; path: string; branch: string | null } | { kind: "push"; branch: string } | { kind: "pr"; prUrl: string };

function words(seg: string): string[] { return seg.trim().split(/\s+/).filter(Boolean); }
export function recognise(command: string, output: string, cwd: string): Recorded[] {
  const out: Recorded[] = [];
  for (const seg of command.split(/&&|\|\||;|\n/)) {
    const w = words(seg).filter((x) => !x.startsWith("-c") || x.length > 2);
    const gi = w.findIndex((x) => x === "git" || x.endsWith("/git"));
    if (gi >= 0 && w[gi + 1] === "worktree" && w[gi + 2] === "add") {
      const rest = w.slice(gi + 3); const bi = rest.indexOf("-b"); const branch = bi >= 0 ? rest[bi + 1] : null;
      const pos = rest.filter((x, i) => !x.startsWith("-") && (bi < 0 || (i !== bi && i !== bi + 1)));
      if (pos[0]) out.push({ kind: "worktree", path: isAbsolute(pos[0]) ? pos[0] : join(cwd, pos[0]), branch });
    } else if (gi >= 0 && w[gi + 1] === "push" && (w.includes("-u") || w.includes("--set-upstream"))) {
      const pos = w.slice(gi + 2).filter((x) => !x.startsWith("-"));
      const ref = pos[1] ?? pos[0]; if (ref) out.push({ kind: "push", branch: ref.split(":").pop()! });
    } else if (w[0] === "gh" && w[1] === "pr" && w[2] === "create") {
      const m = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/); if (m) out.push({ kind: "pr", prUrl: m[0] });
    }
  }
  return out;
}
```
`src/git.ts` and `src/gh.ts`: thin wrappers around `Bun.spawnSync` returning trimmed stdout or null on non-zero exit. `git.worktrees` parses `git worktree list --porcelain` (`worktree <path>` / `branch refs/heads/<b>` / `detached`). `gh.prForBranch(slug, branch)` runs `gh pr view <branch> --repo <slug> --json number,url,isDraft,state,baseRefName` and maps to `Pr` plus `base`. `gh.myPrs(slug)` runs `gh pr list --repo <slug> --author <github_user> --state open --json number,url,isDraft,state,headRefName,baseRefName`.

Run → PASS.

- [ ] **Step 3: Record into the session's workset**

In `hook.ts` add:
```ts
case "afterCommand": {
  const key = pointerKey(e.harness, e.session); const name = currentWorkset(key); if (!name) return {};
  const ws = loadWorkset(name) ?? createWorkset(name, key);
  for (const r of recognise(e.command, e.output, e.cwd)) {
    if (r.kind === "worktree") { const repo = git.repoRoot(r.path) ?? git.repoRoot(e.cwd); if (!repo) continue;
      addMember(ws, { repo: git.mainWorktree(repo), slug: git.remoteSlug(repo), branch: r.branch ?? git.currentBranch(r.path) ?? "HEAD", worktree: r.path, added_by: key }); }
    if (r.kind === "push") { const repo = git.repoRoot(e.cwd); if (!repo) continue;
      addMember(ws, { repo: git.mainWorktree(repo), slug: git.remoteSlug(repo), branch: r.branch, worktree: e.cwd, added_by: key }); }
    if (r.kind === "pr") { const repo = git.repoRoot(e.cwd); const slug = repo && git.remoteSlug(repo); const branch = repo && git.currentBranch(repo);
      if (slug && branch) { const pr = gh.prForBranch(slug, branch); if (pr) addMember(ws, { repo: git.mainWorktree(repo!), slug, branch, worktree: e.cwd, pr: pr.pr, base: pr.base, added_by: key }); } }
  }
  saveWorkset(ws); return {};
}
```
Where `git.mainWorktree(repo)` returns the first path from `git worktree list`. `git.repoRoot` returns null outside a repo. Add `src/hook.test.ts` cases with a temporary git repo (`git init`, `git worktree add`) asserting the member appears; `gh` is stubbed by setting `WORKBENCH_GH_STUB=<json file>` which `gh.ts` reads when present.

- [ ] **Step 4: Commit** — `git commit -m "workbench: record worktrees, pushes and PRs from agent commands"`.

---

### Task 5: Derivation and unclaimed items

**Files:**
- Create: `src/derive.ts`, `src/cmd/scan.ts`, `test/derive.test.ts`
- Modify: `src/cmd/workset.ts` (`adopt`, `ignore`, `prune`), `src/cli.ts`

**Interfaces:**
- Produces: `derive(config): Found[]` where `Found = { repo: string; slug: string | null; branch: string; worktree: string | null; pr: Pr | null; base: string | null }`; `unclaimed(found, worksets): Found[]`; `prunable(found): { found: Found; reason: "merged" | "remote-gone" }[]`.

- [ ] **Step 1: Failing tests**

```ts
test("derive lists worktree branches in configured roots and skips excluded repos", ...); // builds two temp repos, one excluded; asserts branches found from `git worktree list` in each
test("unclaimed excludes members of any workset and ignored ids", ...);
test("prunable flags a worktree whose branch's upstream is gone", ...); // `git branch --unset-upstream` vs upstream deleted: use `git for-each-ref --format='%(upstream:track)'` equals "[gone]"
```
Run → FAIL.

- [ ] **Step 2: Implement**

`derive(config)`: expand each `repo_roots` glob (`Bun.Glob` with `onlyFiles: false`), keep directories with `.git`, drop `exclude_repos`; for each repo, `git.worktrees(repo)` plus every directory under each `worktree_dirs` entry (relative ones under the repo, absolute ones globally) that is a git worktree of that repo (`git rev-parse --git-common-dir` equal); skip the main worktree on its default branch; attach `pr` from `gh.myPrs(slug)` matched by `headRefName` (one `gh` call per repo, cached per run); `base` from the PR's `baseRefName`.

`unclaimed(found, worksets)`: ids `slug#branch` not in any workset's members or `ignored`.

`prunable`: `%(upstream:track)` is `[gone]`, or `pr.state === "MERGED"`.

`workbench scan [--json]` prints found items grouped by workset claim: claimed (with workset), unclaimed, prunable. `workset adopt <name> <id> [--role]`, `workset ignore <name> <id>`, `workset prune <id> --yes` (runs `git worktree remove` and `git branch -D` only when prunable and `--yes`; prints the commands otherwise).

- [ ] **Step 3: Commit** — `git commit -m "workbench: derive members from repos and gh; unclaimed and prune"`.

---

### Task 6: Diff base and stack order

**Files:**
- Create: `src/stack.ts`, `test/stack.test.ts`
- Modify: `src/cmd/workset.ts` (`show` prints base and order)

**Interfaces:**
- Produces: `diffBase(member, config): string` and `orderMembers(members): Member[]` (stable: explicit `order` first, then base-chain depth, then branch name); `stackNodes(members): { repo: string; bottomBase: string; top: Member }[]` for whole-stack views.

- [ ] **Step 1: Failing tests**

```ts
test("diff base prefers pr base, then declared base, then default branch", ...);
test("base chain orders a stack bottom-up", () => {
  // a: base main; b: base a; c: base b (via pr.base) -> [a, b, c]
});
test("explicit order wins over the chain", ...);
test("whole-stack node spans bottom base to top member", ...);
```

- [ ] **Step 2: Implement** per the tests; `pr.base` is stored on the member as `base` when the PR was fetched, so `diffBase` is `member.base ?? config.default_branch` after Task 4 stores both (keep a `base_source: "pr" | "declared" | "default"` field for `show`).

- [ ] **Step 3: Commit** — `git commit -m "workbench: diff base and stack order"`.

---

### Task 7: Review window: tmux, hunk and the sidebar

**Files:**
- Create: `src/tmux.ts`, `src/hunk.ts`, `src/review.ts`, `src/sidebar.ts`, `src/cmd/open.ts`, `src/cmd/sidebar.ts`, `test/review-open.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `openReview(name, { allowDirty }): Review`, `Review = { id: string; workset: string; opened: string; snapshot: Record<memberId, { tip: string; dirty: string[] }>; locked: string[] }` saved at `reviews/<workset>.json`; `tmux.ensureSession(name, cwd)`, `tmux.splitSidebar(session, cmd)`, `tmux.switchOrAttach(session)`; `hunk.start(pane, worktree, base, branch)`, `hunk.reload(paneCwd, worktree, base, branch)`, `hunk.userComments(worktree): RawNote[]`, `hunk.addAgentComment(worktree, note)`.

- [ ] **Step 1: Failing open test**

```ts
test("open refuses a dirty work worktree and names the file", () => {
  // temp repo with a member worktree and an uncommitted file; expect openReview to throw with the path
});
test("open with allowDirty records the dirty files in the snapshot", ...);
test("open snapshots each member tip sha and writes the lock with work worktrees only", () => {
  // two members: role work and role throwaway; lock.paths contains only the work one
});
```
tmux and hunk are behind `WORKBENCH_DRY_RUN=1` which makes `tmux.ts` and `hunk.ts` record commands into `review.commands[]` instead of spawning.

- [ ] **Step 2: Implement open**

`openReview`: load workset; order members; for each `work` member with a worktree, `git.isDirty` → collect; throw unless `allowDirty`; snapshot `tip = git.revParse(worktree, "HEAD")`; write lock `locks/<workset>.json` `{ workset, review: id, paths: [worktrees], opened, holder: os.userInfo().username }`; save review. Then `tmux.ensureSession("wb-" + name, firstWorktree)`: `tmux new-session -d -s wb-<name> -c <wt> -x 220 -y 60` if missing; in pane 0 run `cd <wt> && hunk diff <base>...<branch> --watch`; `tmux split-window -h -b -l 44 -c <wt> 'workbench sidebar <name>'`; then `tmux switch-client -t wb-<name>` if `$TMUX` is set else `tmux attach -t wb-<name>`.

`hunk.reload(paneCwd, worktree, base, branch)`: `hunk session reload --session-path <paneCwd> --source <worktree> -- diff <base>...<branch>`. Record the hunk pane's cwd in the review (`hunkPaneCwd`) so reload can address it after the user moved.

- [ ] **Step 3: Sidebar v0**

`src/sidebar.ts`: raw-mode loop (`process.stdin.setRawMode(true)`), renders: workset name; one line per ordered member `[role] slug#branch  PR #n draft|open|merged  (base → branch)`, a `whole stack` line per repo with more than one member, an `unclaimed (n)` section from `derive`, and a `sessions` section from pointers whose `workset` matches (`open`/`closed`, Task 10 adds inbox state). Keys: `j`/`k` move, `Enter` re-points hunk, `a` adopt selected unclaimed, `i` ignore, `r` rescan, `s` submit (Task 9), `c` close (Task 9), `q` quit sidebar only. Re-render on a 5 s timer and after each key. Keep it under 250 lines; OpenTUI is a later option.

- [ ] **Step 4: Manual check**

`workbench open spike` from inside tmux: a new session `wb-spike`, sidebar left, hunk right on the first member; `Enter` on another member swaps the diff; `e` in hunk opens neovim; saving refreshes under `--watch`; `switch-client -l` returns. Fix what breaks; record any hunk 0.23 CLI differences in the spec's open questions.

- [ ] **Step 5: Commit** — `git commit -m "workbench: review window with tmux, hunk and a sidebar"`.

---

### Task 8: Lock enforcement in the adapter

**Files:**
- Create: `src/lock.ts`, `test/lock.test.ts`
- Modify: `src/hook.ts` (`beforeWrite`, `beforeCommand`, `promptSubmitted`)

**Interfaces:**
- Produces: `activeLocks(): Lock[]`, `lockFor(path): Lock | null` (path is resolved absolute; a path is locked when it equals or is under a lock path), `looksLikeWrite(command): boolean`, `commandTouches(command, cwd, lockPaths): string | null`.

- [ ] **Step 1: Failing tests**

```ts
test("Edit under a locked worktree is denied with the holder", ...);        // relative file_path resolved against cwd
test("Edit outside is allowed", ...);
test("Bash git commit with cwd inside a locked worktree is denied", ...);
test("Bash git status inside a locked worktree is allowed", ...);
test("Bash cd <locked> && sed -i is denied", ...);
test("Bash that names a locked path with > redirection is denied", ...);
test("Bash that only cats a locked file is allowed", ...);
test("prompt submitted while a lock exists injects a context line naming the workset", ...);
```

- [ ] **Step 2: Implement**

`looksLikeWrite`: regex over the command for `\bgit\s+(commit|rebase|reset|checkout|switch|merge|cherry-pick|stash|apply|am|push|mv|rm|clean|restore)\b`, `(^|[^<])>{1,2}(?!&)`, `\bsed\s+(-[a-zA-Z]*i|--in-place)`, `\b(rm|mv|cp|tee|truncate|chmod|chown)\b`, `\bterraform\s+(apply|state|import)\b`. `commandTouches`: resolve `cwd` plus every `cd <path>` segment target in order; a lock applies when any effective cwd is under a lock path or any whitespace-delimited token resolves under one. Deny text: `workbench: <path> is locked by review <id> of workset <name> (held by <user>); it is released on submit or close. Work elsewhere until then.`

`promptSubmitted`: when any lock exists, context: `workbench: review open on workset <name>; worktrees <paths> are locked until submit or close. Do not edit there.`

- [ ] **Step 3: Commit** — `git commit -m "workbench: enforce review locks through the hooks"`.

---

### Task 9: Submit and close

**Files:**
- Create: `src/comments.ts`, `src/submit.ts`, `src/cmd/submit.ts`, `src/cmd/close.ts`, `test/comments.test.ts`, `test/submit.test.ts`
- Modify: `src/sidebar.ts` (`s`, `c`), `src/cli.ts`

**Interfaces:**
- Produces: `parseSigil(text): { type: "change" | "question" | "note"; text: string }`, `normaliseNotes(raw: unknown[]): Comment[]`; `submitReview(name, { message }): ReviewFile`; `closeReview(name)`.
```ts
type Comment = { id: string; repo: string; slug: string | null; branch: string; path: string; line: { side: "new" | "old"; start: number; end: number }; sha: string; type: "change" | "question" | "note"; text: string; replies: Reply[] };
type EditCommit = { repo: string; branch: string; sha: string; files: string[] };
type ReviewFile = { id: string; workset: string; submitted: string; message: string | null; comments: Comment[]; edits: EditCommit[]; sessions: string[] };
```

- [ ] **Step 1: Probe hunk's note JSON**

With a hunk session open and one `c` note saved, run `hunk session comment list --repo <wt> --type user --json > test/fixtures/hunk-user-notes.json` and `hunk session review --repo <wt> --include-notes --json | head -c 4000`. Record the field names (expected: `id`, `filePath`, `newLine` or `oldLine`, `summary`, `rationale`, `author`). The fixture is the contract for `normaliseNotes`.

- [ ] **Step 2: Failing tests**

```ts
test("sigils", () => { expect(parseSigil("? why two secrets")).toEqual({ type: "question", text: "why two secrets" }); expect(parseSigil("// fine")).toMatchObject({ type: "note" }); expect(parseSigil("rename this")).toMatchObject({ type: "change" }); });
test("normalise hunk notes fixture", () => { const c = normaliseNotes(JSON.parse(readFileSync(fixture, "utf8"))); expect(c[0]).toMatchObject({ path: expect.any(String), line: { side: "new" } }); });
test("submit commits only files changed since open, one commit per branch, with trailers", ...);   // temp repo, edit two files, one pre-existing dirty file excluded via snapshot
test("submit writes the review to every bound session's inbox and releases the lock", ...);        // two pointers bound
test("submit skips a member whose worktree vanished", ...);
test("submit with no live hunk session treats comments as empty", ...);                               // WORKBENCH_DRY_RUN stub returns ""
test("close releases the lock and keeps the review file for rehydration", ...);
```

- [ ] **Step 3: Implement submit**

Order: (1) load review and lock; (2) for each `work` member with a worktree that still exists: `changed = git diff --name-only` plus untracked, minus `snapshot.dirty`; if non-empty, `git add -- <files>` then `git commit -m <message or "Review edits (workbench)"> --trailer "Workset: <name>" --trailer "Review: <id>"`; record `EditCommit`; (3) `hunk.userComments(worktree)` → `normaliseNotes` → sigils → anchor `sha = git.revParse(worktree, branch)`; (4) prompt once for the overall message when stdin is a TTY and `--message` is absent (`readline`), default empty; (5) write `ReviewFile` to `inbox/<session>/<id>.json` for every `ws.sessions` pointer that is open, and to `reviews/<workset>/<id>.json` as the archive; (6) remove the lock and the open review file; (7) print the summary: commits, comment counts by type, sessions notified. `closeReview`: remove lock and open review file only.

Sidebar `s` runs submit in the sidebar pane (prompt for message inline), `c` runs close; both then kill the tmux session after a confirmation keypress.

- [ ] **Step 4: Commit** — `git commit -m "workbench: submit and close reviews"`.

---

### Task 10: Inbox and wake-up

**Files:**
- Create: `src/inbox.ts`, `src/render.ts`, `src/cmd/inbox.ts`, `test/inbox.test.ts`
- Modify: `src/hook.ts` (`turnEnded`, `sessionStarted` start watcher), `claude/settings.json` (asyncRewake entries)

**Interfaces:**
- Produces: `inbox.list(sessionKey): ReviewFile[]`, `inbox.markRead(sessionKey, id)`, `inbox.wait(sessionKey, timeoutMs): ReviewFile | null`, `renderMarkdown(review): string`; CLI `workbench inbox list|show [id]|wait --session <key> [--timeout 7200]`.

- [ ] **Step 1: Failing tests**

```ts
test("render markdown groups comments by member and path with type badges and sha", ...);
test("wait returns when a review file appears and exits code 2 semantics are the caller's", ...);
test("show marks the review read; list shows unread first", ...);
test("a second watcher replaces the first via the pid file", ...);
```

- [ ] **Step 2: Implement**

`inbox.wait`: poll the session's inbox dir every 2 s (`fs.watch` is unreliable across tmp mounts) until a file with `read: false` exists or timeout; write `watch/<key>.pid` with the current pid at start and kill the previous pid if alive. `cmd/inbox.ts wait`: on arrival print to stderr `workbench: a review arrived for workset "<name>" (<n> comments, <m> edit commits). Run \`workbench inbox show --session <key>\` and follow the workbench-review skill.` and `process.exit(2)`; on timeout exit 0 silently.

`renderMarkdown`: header with workset, id, time, overall message; per member: `### <slug>#<branch> @ <sha7>`; per comment: `- **change** `path:line` — text` and replies indented; then `## Your edits were committed` listing `repo branch sha files`.

Hooks: in `claude/settings.json` add
```json
"SessionStart": [ ...sync entry..., { "hooks": [{ "type": "command", "command": "workbench hook claude --watch", "asyncRewake": true }] }],
"Stop":         [{ "hooks": [{ "type": "command", "command": "workbench hook claude --watch", "asyncRewake": true }] }]
```
`cmd/hook.ts --watch`: parse stdin for the session key, then `exec` the wait with a 2-hour timeout (the Stop hook restarts it every turn, replacing the pid). Verify with two terminals: `workbench submit` in one, the Claude session in the other wakes with the reminder.

- [ ] **Step 3: Commit** — `git commit -m "workbench: inbox, markdown rendering and wake-up watcher"`.

---

### Task 11: Agent skill and reply write-back

**Files:**
- Create: `claude/skills/workbench-review/SKILL.md`, `src/reply.ts`, `src/cmd/reply.ts`, `test/reply.test.ts`
- Modify: `src/review.ts` (rehydrate on open), `src/cli.ts`

**Interfaces:**
- Produces: `workbench reply --session <key> --review <id> --comment <comment-id> --text <t>`: appends `{ at, by: sessionKey, text }` to the comment's `replies` in the inbox file and the archive; if `hunk.hasSession(worktree)` adds an agent comment at the same file and line with `--author <sessionKey>` and summary `↩ <text>`. `openReview` rehydrates: for each archived review of the workset with replies, after hunk starts, `hunk.addAgentComment` for each reply not yet shown (tracked by `shown_in: string[]` on the reply).

- [ ] **Step 1: Failing tests** — reply appends to both files; reply with no live session skips hunk and sets no `shown_in`; rehydrate adds exactly the unshown replies (dry-run command log).

- [ ] **Step 2: Implement** per the interface.

- [ ] **Step 3: Skill**

`claude/skills/workbench-review/SKILL.md`:
```markdown
---
name: workbench-review
description: Use when a system reminder says a workbench review arrived, or the user says to check the workbench inbox. Reads the review, treats the user's edit commits as canonical, works through change requests, and replies to questions and notes beside the comment.
---

# Workbench review

A review is a batch of comments and edits the user made in the review window against this session's workset.

1. Run `workbench inbox show --session <your key>` (the key is in the session-start context: `claude-<session id>`). Read all of it before acting.
2. For each repo in "Your edits were committed", run `git -C <worktree> log --oneline -5` and `git -C <worktree> show --stat <sha>`. Those commits are the user's and are canonical: build on them, never amend, rebase, squash or revert them. If the overall message explicitly says to squash, say so in your reply and do it only then.
3. Work through **change** comments in order. For each, make the change in the worktree, commit as usual, then `workbench reply --session <key> --review <id> --comment <comment id> --text "<what you did, one line, with the commit sha>"`.
4. Answer **question** comments with `workbench reply ... --text "<answer>"`. Keep answers to a few sentences; a change that follows from the answer is a separate change you make and reply about.
5. Acknowledge **note** comments only when they change what you do; otherwise leave them.
6. End with one line in the conversation: review id, counts of changes made, questions answered, anything you disagreed with and why. Then resume what you were doing.

Never edit files under a locked worktree (a tool call is denied with the lock holder's name); wait for the lock to release.
```

- [ ] **Step 4: Commit** — `git commit -m "workbench: review skill and reply write-back"`.

---

### Task 12: Session state in the sidebar, README, end-to-end check

**Files:**
- Modify: `src/sidebar.ts` (session lines show `open`, `closed`, `review unread`, `replies n/m`)
- Create: `local/lib/workbench/README.md`

- [ ] **Step 1: Sidebar session state** from pointers and inbox: `claude-abc  open  inbox: 1 unread  replies 2/5`.

- [ ] **Step 2: README** — purpose (two sentences from the spec), install (rcup, bun, hunk ≥ 0.23), the five commands (`workset`, `scan`, `open`, `submit`, `inbox`), the review flow in six lines, a pointer to CONTEXT.md and the spec.

- [ ] **Step 3: End-to-end** — with a real spike workset: start a scratch Claude session bound with `workset use`, `workbench open spike`, leave one comment of each type, edit one doc line via `e`, submit with a message; confirm the commit (author, trailers), the inbox file, the wake-up, the agent's reply appearing in hunk after `workbench open spike` again. Record deviations in the spec's open questions.

- [ ] **Step 4: Commit** — `git commit -m "workbench: session state in the sidebar; README"`.
