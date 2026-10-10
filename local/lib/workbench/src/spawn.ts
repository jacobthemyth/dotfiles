// The one place tmux.ts and hunk.ts spawn from. WORKBENCH_DRY_RUN=1 records the argv instead.
// In a dry run, WORKBENCH_DRY_RUN_FAIL (comma-separated argv prefixes) makes matching commands exit 1.
export const dryRun = () => process.env.WORKBENCH_DRY_RUN === "1";

let recorded: string[] = [];
export function drainRecorded(): string[] { const out = recorded; recorded = []; return out; }

export type Result = { code: number; stdout: string; stderr: string };
export function run(argv: string[], opts: { inherit?: boolean; dryStdout?: string } = {}): Result {
  if (dryRun()) {
    const line = argv.join(" ");
    recorded.push(line);
    const fails = (process.env.WORKBENCH_DRY_RUN_FAIL ?? "").split(",").filter(Boolean);
    return fails.some((f) => line.startsWith(f)) ? { code: 1, stdout: "", stderr: "dry-run failure" } : { code: 0, stdout: opts.dryStdout ?? "", stderr: "" };
  }
  try {
    const io = opts.inherit ? "inherit" : "pipe";
    const r = Bun.spawnSync(argv, { stdin: opts.inherit ? "inherit" : "ignore", stdout: io, stderr: io });
    return { code: r.exitCode ?? 1, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
  } catch (e) { return { code: 127, stdout: "", stderr: (e as Error).message }; }
}
