import { appendFileSync } from "node:fs";
import { parseClaudeHook, renderClaudeOutcome } from "../harness/claude";
import { handle } from "../hook";

// Hooks must never block or add noise: every failure is logged to stderr and exits 0.
export async function run(args: string[]): Promise<number> {
  const [harness] = args;
  if (harness !== "claude") { console.error("workbench hook: unknown harness"); return 2; }
  try {
    const raw = (await Bun.stdin.text()).trim();
    if (!raw) return 0;
    const debug = process.env.WORKBENCH_HOOK_DEBUG;
    if (debug) appendFileSync(debug, raw + "\n");
    const event = parseClaudeHook(JSON.parse(raw));
    if (!event) return 0;
    const out = renderClaudeOutcome(event, handle(event));
    if (out) process.stdout.write(out);
  } catch (e) {
    console.error(`workbench hook: ${(e as Error).message}`);
  }
  return 0;
}
