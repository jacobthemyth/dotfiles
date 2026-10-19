import { readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sub } from "./paths";
import { loadPointer } from "./session";
import { readJson, removeFile, writeJson } from "./store";
import { inboxFile, type ReviewFile } from "./submit";

export type InboxReview = ReviewFile & { read: boolean };
const inboxDir = (key: string) => join(sub("inbox"), key);
const pidFile = (key: string) => join(sub("watch"), `${key}.pid`);

export const removeInbox = (key: string): void => rmSync(inboxDir(key), { recursive: true, force: true });
export const removePidFile = (key: string): void => removeFile(pidFile(key));

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

type Entry = { pid: number; started: number; token: string };
function readEntry(key: string): Entry | null {
  try {
    const e = JSON.parse(readFileSync(pidFile(key), "utf8")) as Partial<Entry>;
    return Number.isInteger(e.pid) && (e.pid as number) > 1 && typeof e.started === "number" && typeof e.token === "string" ? (e as Entry) : null;
  } catch { return null; }
}

// True only for a live process that is a workbench command whose elapsed time fits the pid file:
// a recycled pid fails one of the two checks.
function isOurWatcher(e: Entry): boolean {
  if (e.pid <= 1 || e.pid === process.pid || !alive(e.pid)) return false;
  const r = Bun.spawnSync(["ps", "-p", String(e.pid), "-o", "etime=,command="], { stdout: "pipe", stderr: "ignore" });
  const m = r.stdout.toString().trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/);
  if (!m || !m[5].includes("workbench")) return false;
  const elapsed = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
  return Date.now() - elapsed * 1000 <= e.started + 2000; // elapsed time sidesteps ps's local-time lstart
}

// The kill decision for a pid file's entry, logged on stderr so a lingering watcher can be diagnosed.
function stopIfOurs(key: string, e: Entry): void {
  if (!isOurWatcher(e)) { console.error(`workbench: ignoring stale pid file for ${key}`); return; }
  console.error(`workbench: stopping watcher ${e.pid}`);
  try { process.kill(e.pid, "SIGTERM"); } catch { /* already gone */ }
}

// Stops the key's registered watcher if it verifiably is one, and removes the pid file.
export function stopWatcher(key: string): void {
  const e = readEntry(key);
  if (e) stopIfOurs(key, e);
  removeFile(pidFile(key));
}

// Closed since `since`: a pointer closed earlier is a resume in flight (SessionStart runs the watcher and the
// hook that reopens the pointer in parallel), not an end.
const closedSince = (key: string, since: number): boolean => {
  try { const c = loadPointer(key)?.closed; return !!c && Date.parse(c) >= since; } catch { return false; }
};

// Polls (fs.watch is unreliable across tmp mounts). Registers in watch/<key>.pid, replacing any previous
// watcher, and gives up (null) if a newer live watcher takes the pid file or the session's pointer closes.
export async function wait(key: string, timeoutMs: number, pollMs = 2000): Promise<ReviewFile | null> {
  const me = process.pid;
  const prev = readEntry(key);
  if (prev && prev.pid !== me) stopIfOurs(key, prev);
  const mine: Entry = { pid: me, started: Date.now(), token: randomBytes(8).toString("hex") };
  writeJson(pidFile(key), mine);
  const ours = () => readEntry(key)?.token === mine.token;
  const cleanup = () => { if (ours()) removeFile(pidFile(key)); };
  const onSignal = () => { cleanup(); process.exit(0); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const unread = list(key).filter((r) => !r.read);
      if (unread.length) return unread[unread.length - 1];
      if (closedSince(key, mine.started)) return null; // SessionEnd may fail to kill us; a closed pointer ends us
      const owner = readEntry(key);
      if (owner && owner.token !== mine.token && owner.pid !== me && isOurWatcher(owner)) return null;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
  } finally {
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    cleanup();
  }
}
