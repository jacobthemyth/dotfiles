import { dryRun, run } from "./spawn";

export const sessionName = (workset: string) => `wb-${workset}`;
export type Pane = { id: string; dead: boolean; command: string; start: string };

// Dry runs read tmux state from WORKBENCH_DRY_RUN_TMUX: {"sessions": {"wb-x": {"panes": [{"id", "dead"?, "command"?, "start"?}]}}}.
type DryState = { sessions?: Record<string, { panes?: Partial<Pane>[] }> };
const dryState = (): DryState => { try { return JSON.parse(process.env.WORKBENCH_DRY_RUN_TMUX ?? "{}"); } catch { return {}; } };

export function hasSession(session: string): boolean {
  const code = run(["tmux", "has-session", "-t", `=${session}`]).code;
  return dryRun() ? !!dryState().sessions?.[session] : code === 0;
}

export function listPanes(session: string): Pane[] {
  const r = run(["tmux", "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_start_command}"]);
  if (dryRun()) {
    return (dryState().sessions?.[session]?.panes ?? []).map((p) => ({ id: p.id ?? "", dead: !!p.dead, command: p.command ?? "", start: p.start ?? "" }));
  }
  if (r.code !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [id, dead, command, start] = l.split("\t");
    return { id, dead: dead === "1", command: command ?? "", start: start ?? "" };
  });
}

// Creates a detached session; returns its only pane's id.
export function newSession(session: string, cwd: string): string {
  const r = run(["tmux", "new-session", "-d", "-s", session, "-c", cwd, "-x", "220", "-y", "60", "-P", "-F", "#{pane_id}"], { dryStdout: "%1" });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`workbench: tmux new-session failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// A new shell pane to the right of `pane`; returns its id.
export function splitRight(pane: string, cwd: string): string {
  const r = run(["tmux", "split-window", "-h", "-t", pane, "-c", cwd, "-P", "-F", "#{pane_id}"], { dryStdout: "%3" });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`workbench: tmux split-window failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export function paneCwd(pane: string): string | null {
  const r = run(["tmux", "display-message", "-p", "-t", pane, "#{pane_current_path}"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Replaces whatever runs in the pane with argv (the pane closes when argv exits).
export function respawn(pane: string, cwd: string, argv: string[]): boolean {
  return run(["tmux", "respawn-pane", "-k", "-t", pane, "-c", cwd, ...argv]).code === 0;
}

export function splitSidebar(pane: string, cwd: string, cmd: string): void {
  const r = run(["tmux", "split-window", "-h", "-b", "-l", "44", "-c", cwd, "-t", pane, cmd]);
  if (r.code !== 0) throw new Error(`workbench: tmux split-window failed: ${r.stderr.trim()}`);
}

export const resizeWidth = (pane: string, cols: number) => run(["tmux", "resize-pane", "-t", pane, "-x", String(cols)]).code === 0;

export function switchOrAttach(session: string): number {
  return process.env.TMUX
    ? run(["tmux", "switch-client", "-t", session]).code
    : run(["tmux", "attach", "-t", session], { inherit: true }).code;
}
