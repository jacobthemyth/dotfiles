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

// Submits (prompting for the message here); submit pauses on a key, then kills the review window. False when submit failed.
export async function submitInPane(name: string): Promise<boolean> {
  takeOver();
  try { await submitReview(name, { beforeKill: anyKey }); } catch (e) { console.log((e as Error).message); await anyKey(); return false; }
  return true;
}

// Releases the lock and returns to the sidebar; the window stays (comments live only in hunk's memory).
export async function closeInPane(name: string): Promise<void> {
  takeOver();
  try { console.log(closedLine(name, closeReview(name))); } catch (e) { console.log((e as Error).message); }
  await anyKey();
}
