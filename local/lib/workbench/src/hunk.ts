import { dryRun, run } from "./spawn";
import * as tmux from "./tmux";

// A user or agent note as `hunk session comment list --type <all|user> --json` returns it (hunk 0.23).
export type RawNote = {
  noteId: string; source: string; filePath: string; hunkIndex?: number;
  newRange?: [number, number]; oldRange?: [number, number]; body: string;
  author?: string; createdAt?: string; editable?: boolean; parentId?: string;
};
// An agent comment: anchored to a file line, or (replyTo) threaded under an existing note.
export type AgentNote = { file?: string; newLine?: number; oldLine?: number; replyTo?: string; summary: string; rationale?: string; author?: string };
// How to address a live hunk session: its id when known, else the path it is rooted at.
export type Target = { id: string | null; path: string };

const address = (t: Target) => (t.id ? [t.id] : ["--repo", t.path]);

// ref is a single revision (the merge base, so the working tree shows) or a `<base>...<branch>` range.
// paths, when given, follow `--` and limit the diff to those pathspecs (`hunk diff [target] [-- <pathspec...>]`).
const pathspec = (paths: string[]) => (paths.length ? ["--", ...paths] : []);
export function start(pane: string, worktree: string, ref: string, paths: string[] = []): boolean {
  return tmux.respawn(pane, worktree, ["hunk", "diff", ref, "--watch", ...pathspec(paths)]);
}

type Listed = { sessionId: string; terminal?: { locations?: { source: string; paneId?: string }[] } };
// Dry runs read the session list from WORKBENCH_DRY_RUN_HUNK_SESSIONS (the `session list --json` object).
export function sessions(): Listed[] {
  const r = run(["hunk", "session", "list", "--json"], { dryStdout: process.env.WORKBENCH_DRY_RUN_HUNK_SESSIONS });
  try { return r.code === 0 ? (JSON.parse(r.stdout).sessions ?? []) : []; } catch { return []; }
}

export const hasSession = (id: string): boolean => sessions().some((s) => s.sessionId === id);

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
export function reload(t: Target, worktree: string, ref: string, paths: string[] = []): boolean {
  const who = t.id ? [t.id] : ["--session-path", t.path];
  return run(["hunk", "session", "reload", ...who, "--source", worktree, "--json", "--", "diff", ref, ...pathspec(paths)]).code === 0;
}

export function userComments(t: Target): RawNote[] {
  if (dryRun()) return [];
  const r = run(["hunk", "session", "comment", "list", ...address(t), "--type", "user", "--json"]);
  try { return r.code === 0 ? (JSON.parse(r.stdout).comments ?? []) : []; } catch { return []; }
}

// Every note in the session, user and agent. Dry runs read WORKBENCH_DRY_RUN_HUNK_NOTES (the list --json object).
export function allNotes(t: Target): RawNote[] {
  const r = run(["hunk", "session", "comment", "list", ...address(t), "--type", "all", "--json"], { dryStdout: process.env.WORKBENCH_DRY_RUN_HUNK_NOTES });
  try { return r.code === 0 ? (JSON.parse(r.stdout).comments ?? []) : []; } catch { return []; }
}

// True when hunk accepted the comment.
export function addAgentComment(t: Target, note: AgentNote): boolean {
  const line = note.newLine !== undefined ? ["--new-line", String(note.newLine)] : ["--old-line", String(note.oldLine ?? 1)];
  const anchor = note.replyTo ? ["--reply-to", note.replyTo] : ["--file", note.file ?? "", ...line];
  return run(["hunk", "session", "comment", "add", ...address(t), ...anchor, "--summary", note.summary,
    ...(note.rationale ? ["--rationale", note.rationale] : []), ...(note.author ? ["--author", note.author] : []), "--json"]).code === 0;
}
