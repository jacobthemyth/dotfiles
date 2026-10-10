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

// ref is a single revision (the merge base, so the working tree shows) or a `<base>...<branch>` range.
export function start(pane: string, worktree: string, ref: string): boolean {
  return tmux.respawn(pane, worktree, ["hunk", "diff", ref, "--watch"]);
}

type Listed = { sessionId: string; terminal?: { locations?: { source: string; paneId?: string }[] } };
export function sessions(): Listed[] {
  const r = run(["hunk", "session", "list", "--json"]);
  try { return r.code === 0 ? (JSON.parse(r.stdout).sessions ?? []) : []; } catch { return []; }
}

// Polls until the TUI in this tmux pane registers its session, or timeoutMs passes.
export function waitForSession(pane: string, timeoutMs = 5000): string | null {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = sessions().find((s) => s.terminal?.locations?.some((l) => l.source === "tmux" && l.paneId === pane));
    if (hit) return hit.sessionId;
    if (dryRun() || Date.now() >= deadline) return null;
    Bun.sleepSync(250);
  }
}

// hunk 0.23 refuses a --source outside the session's initial root: this only re-points within one worktree.
export function reload(t: Target, worktree: string, ref: string): boolean {
  const who = t.id ? [t.id] : ["--session-path", t.path];
  return run(["hunk", "session", "reload", ...who, "--source", worktree, "--json", "--", "diff", ref]).code === 0;
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
