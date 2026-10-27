import { loadReview } from "../review";

// hunk's $EDITOR while a review window is up (via the workbench-edit-guard shim). An edit made while watching
// would be pre-existing dirt at the next review start, refused there or, with --allow-dirty, left out of the
// submit's commit; so edits wait for a review.
export const GUARD_MESSAGE = "lock first: press r in the sidebar";

type Deps = { exec?: (argv: string[]) => number; pause?: () => void; print?: (s: string) => void };

export function guard(ws: string, editor: string, args: string[], deps: Deps = {}): number {
  const exec = deps.exec ?? ((argv) => Bun.spawnSync(argv, { stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1);
  if (loadReview(ws)) return exec([...editor.split(/\s+/).filter(Boolean), ...args]);
  (deps.print ?? console.log)(GUARD_MESSAGE);
  (deps.pause ?? pauseForKey)();
  return 0;
}

function pauseForKey(): void {
  if (!process.stdin.isTTY) return;
  // One byte from the terminal, raw, so any key continues.
  Bun.spawnSync(["sh", "-c", "stty raw -echo; dd bs=1 count=1 >/dev/null 2>&1; stty sane"], { stdio: ["inherit", "inherit", "inherit"] });
}

export async function run(args: string[]): Promise<number> {
  const ws = process.env.WORKBENCH_EDIT_WORKSET, editor = process.env.WORKBENCH_EDIT_EDITOR || "nvim";
  if (!ws) { console.error("workbench edit-guard: WORKBENCH_EDIT_WORKSET is not set"); return 2; }
  return guard(ws, editor, args);
}
