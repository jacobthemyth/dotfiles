import { realpathSync } from "node:fs";
import { dryRun, run } from "./spawn";
import * as tmux from "./tmux";

// A user or agent note as `hunk session comment list --type <all|user> --json` returns it (hunk 0.23).
export type RawNote = {
  noteId: string; source: string; filePath: string; hunkIndex?: number;
  newRange?: [number, number]; oldRange?: [number, number]; body: string;
  author?: string; createdAt?: string; editable?: boolean; parentId?: string;
};
export type AgentNote = { file: string; newLine?: number; oldLine?: number; summary: string; rationale?: string; author?: string };
// How to address a live hunk session: its id when known, else the path it is rooted at.
export type Target = { id: string | null; path: string };

const address = (t: Target) => (t.id ? [t.id] : ["--repo", t.path]);
const range = (base: string, branch: string) => `${base}...${branch}`;
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export function start(pane: string, worktree: string, base: string, branch: string): void {
  tmux.respawn(pane, worktree, ["hunk", "diff", range(base, branch), "--watch"]);
}

type Listed = { sessionId: string; repoRoot: string; cwd: string; terminal?: { locations?: { source: string; paneId?: string }[] } };
export function sessions(): Listed[] {
  const r = run(["hunk", "session", "list", "--json"]);
  try { return r.code === 0 ? (JSON.parse(r.stdout).sessions ?? []) : []; } catch { return []; }
}

// The tmux pane a live session's TUI runs in.
export function paneOf(id: string): string | null {
  const s = sessions().find((x) => x.sessionId === id);
  return s?.terminal?.locations?.find((l) => l.source === "tmux")?.paneId ?? null;
}

// Polls until a session rooted at the worktree registers (the TUI does that itself) or timeoutMs passes.
export function waitForSession(worktree: string, timeoutMs = 5000): string | null {
  const want = real(worktree);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = sessions().find((s) => real(s.repoRoot) === want || real(s.cwd) === want);
    if (hit) return hit.sessionId;
    if (dryRun() || Date.now() >= deadline) return null;
    Bun.sleepSync(250);
  }
}

// hunk 0.23 refuses a --source outside the session's initial root, so this only re-points within one worktree.
export function reload(t: Target, worktree: string, base: string, branch: string): boolean {
  const who = t.id ? [t.id] : ["--session-path", t.path];
  return run(["hunk", "session", "reload", ...who, "--source", worktree, "--json", "--", "diff", range(base, branch)]).code === 0;
}

export function userComments(t: Target): RawNote[] {
  if (dryRun()) return [];
  const r = run(["hunk", "session", "comment", "list", ...address(t), "--type", "user", "--json"]);
  try { return r.code === 0 ? (JSON.parse(r.stdout).comments ?? []) : []; } catch { return []; }
}

export function addAgentComment(t: Target, note: AgentNote): string | null {
  const line = note.newLine !== undefined ? ["--new-line", String(note.newLine)] : ["--old-line", String(note.oldLine ?? 1)];
  const r = run(["hunk", "session", "comment", "add", ...address(t), "--file", note.file, ...line, "--summary", note.summary,
    ...(note.rationale ? ["--rationale", note.rationale] : []), ...(note.author ? ["--author", note.author] : []), "--json"]);
  try { return r.code === 0 ? JSON.parse(r.stdout).result?.commentId ?? null : null; } catch { return null; }
}
