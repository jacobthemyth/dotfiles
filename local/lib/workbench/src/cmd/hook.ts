import { appendFileSync } from "node:fs";
import { parseClaudeHook, renderClaudeOutcome } from "../harness/claude";
import { handle } from "../hook";
import { wait } from "../inbox";
import { pointerKey } from "../session";
import { arrivalLine } from "./inbox";

const WATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// Background watcher (asyncRewake): exit 2 with the message on stderr only when an unread review exists.
// Every other outcome, including errors, exits 0 so a fault can never wake the session.
async function watch(): Promise<number> {
  try {
    const raw = (await Bun.stdin.text()).trim();
    const event = raw ? parseClaudeHook(JSON.parse(raw)) : null;
    if (!event || !("session" in event) || !event.session) return 0;
    const key = pointerKey(event.harness, event.session);
    const review = await wait(key, WATCH_TIMEOUT_MS);
    if (!review) return 0;
    console.error(arrivalLine(review, key));
    return 2;
  } catch (e) {
    console.error(`workbench hook: ${(e as Error).message}`);
    return 0;
  }
}

// Hooks must never block or add noise: every failure is logged to stderr and exits 0.
export async function run(args: string[]): Promise<number> {
  const [harness] = args;
  // 1, never 2: exit 2 from a hook blocks the tool call.
  if (harness !== "claude") { console.error("workbench hook: unknown harness"); return 1; }
  if (args.includes("--watch")) return watch();
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
