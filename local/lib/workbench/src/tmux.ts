import { dryRun, run } from "./spawn";

export const sessionName = (workset: string) => `wb-${workset}`;

export function hasSession(session: string): boolean {
  return run(["tmux", "has-session", "-t", `=${session}`]).code === 0 && !dryRun();
}

// Creates a detached session if missing. Returns its first pane (id, or `<session>:0.0` in a dry run).
export function ensureSession(session: string, cwd: string): { pane: string; created: boolean } {
  if (hasSession(session)) return { pane: paneId(`${session}:0.0`) ?? `${session}:0.0`, created: false };
  const r = run(["tmux", "new-session", "-d", "-s", session, "-c", cwd, "-x", "220", "-y", "60", "-P", "-F", "#{pane_id}"]);
  if (r.code !== 0) throw new Error(`workbench: tmux new-session failed: ${r.stderr.trim()}`);
  return { pane: r.stdout.trim() || `${session}:0.0`, created: true };
}

function display(target: string, format: string): string | null {
  const r = run(["tmux", "display-message", "-p", "-t", target, format]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
export const paneId = (target: string) => display(target, "#{pane_id}");
export const paneCwd = (target: string) => display(target, "#{pane_current_path}");

// Replaces whatever runs in the pane with argv (the pane closes when argv exits).
export function respawn(pane: string, cwd: string, argv: string[]): void {
  const r = run(["tmux", "respawn-pane", "-k", "-t", pane, "-c", cwd, ...argv]);
  if (r.code !== 0) throw new Error(`workbench: tmux respawn-pane failed: ${r.stderr.trim()}`);
}

export function splitSidebar(pane: string, cwd: string, cmd: string): void {
  const r = run(["tmux", "split-window", "-h", "-b", "-l", "44", "-c", cwd, "-t", pane, cmd]);
  if (r.code !== 0) throw new Error(`workbench: tmux split-window failed: ${r.stderr.trim()}`);
}

export function switchOrAttach(session: string): number {
  return process.env.TMUX
    ? run(["tmux", "switch-client", "-t", session]).code
    : run(["tmux", "attach", "-t", session], { inherit: true }).code;
}
