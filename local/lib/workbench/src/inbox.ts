import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sub } from "./paths";
import { readJson, removeFile, writeJson } from "./store";
import { inboxFile, type ReviewFile } from "./submit";

export type InboxReview = ReviewFile & { read: boolean };
const inboxDir = (key: string) => join(sub("inbox"), key);
const pidFile = (key: string) => join(sub("watch"), `${key}.pid`);

function load(key: string): InboxReview[] {
  const dir = inboxDir(key);
  if (!existsSync(dir)) return [];
  const out: InboxReview[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as InboxReview); } catch { /* half-written or corrupt: skip */ }
  }
  return out;
}

// Unread first, then newest first.
export function list(key: string): InboxReview[] {
  return load(key).sort((a, b) => Number(a.read) - Number(b.read) || b.submitted.localeCompare(a.submitted));
}
export const get = (key: string, id: string): InboxReview | null => readJson<InboxReview>(inboxFile(key, id));
export function markRead(key: string, id: string): void {
  const r = get(key, id);
  if (r && !r.read) writeJson(inboxFile(key, id), { ...r, read: true });
}
export const unreadCount = (key: string): number => load(key).filter((r) => !r.read).length;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
function readPid(key: string): number | null {
  try { const n = Number(readFileSync(pidFile(key), "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}

// Polls (fs.watch is unreliable across tmp mounts). Registers in watch/<key>.pid, replacing any previous
// watcher, and gives up (null) if a newer live watcher takes the pid file.
export async function wait(key: string, timeoutMs: number, pollMs = 2000): Promise<ReviewFile | null> {
  const me = process.pid;
  const prev = readPid(key);
  if (prev && prev !== me && alive(prev)) { try { process.kill(prev, "SIGTERM"); } catch { /* already gone */ } }
  writeJson(pidFile(key), me); // JSON number == plain digits
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const unread = list(key).filter((r) => !r.read);
      if (unread.length) return unread[unread.length - 1];
      const owner = readPid(key);
      if (owner && owner !== me && alive(owner)) return null;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
  } finally {
    if (readPid(key) === me) removeFile(pidFile(key));
  }
}
