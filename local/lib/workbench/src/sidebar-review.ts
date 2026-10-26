import { createInterface } from "node:readline/promises";
import { closeReview, closedLine, submitReview } from "./submit";

// The sidebar's submit and close: the pane is in line mode while these run.
const anyKey = () => new Promise<void>((resolve) => {
  process.stdout.write("\npress any key… ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once("data", () => resolve());
});

function takeOver(): void {
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[H\x1b[2J");
}

// Submits (prompting for the message here) and pauses on a key so the summary can be read; the window stays up,
// watching. False when submit failed.
export async function submitInPane(name: string): Promise<boolean> {
  takeOver();
  let ok = true;
  try { await submitReview(name); } catch (e) { console.log((e as Error).message); ok = false; }
  await anyKey();
  return ok;
}

export const CLOSE_WARNING =
  "Close the review without submitting? The lock is released and the window stays up.";
export const confirmsClose = (answer: string) => answer.trim().toLowerCase() === "yes";

async function askYes(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question("Type yes to close: "); } finally { rl.close(); }
}

export type CloseOptions = { ask?: () => Promise<string>; log?: (line: string) => void; pause?: () => Promise<void> };

// Closes only on an explicit "yes": in hunk `c` means comment, so a stray `c` here must not release the review.
// Anything else cancels and the review stays open. True when the review was closed.
export async function confirmClose(name: string, opts: CloseOptions = {}): Promise<boolean> {
  const log = opts.log ?? console.log, pause = opts.pause ?? anyKey;
  log(CLOSE_WARNING);
  const answer = await (opts.ask ?? askYes)().catch(() => "");
  let closed = false;
  if (!confirmsClose(answer)) log("close cancelled");
  else {
    try { log(closedLine(name, closeReview(name))); closed = true; } catch (e) { log((e as Error).message); }
  }
  await pause();
  return closed;
}

// Asks, then releases the lock and returns to the sidebar; the window stays, watching.
export async function closeInPane(name: string): Promise<boolean> {
  takeOver();
  return confirmClose(name);
}
