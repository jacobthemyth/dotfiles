import { join } from "node:path";
import { sub } from "./paths";
import { isAlive } from "./harness/claude";
import { readJson, writeJson, now, listJson, removeFile } from "./store";
import { loadWorkset, saveWorkset, type Workset } from "./workset";

export type Pointer = { key: string; harness: string; session: string; workset: string | null; cwd: string; opened: string; closed: string | null; closed_reason?: "stale" };
export type PointerState = "open" | "stale" | "closed";
const dir = () => sub("sessions");
export const pointerKey = (harness: string, session: string) => `${harness}-${session}`;
const file = (key: string) => join(dir(), `${key}.json`);
export const loadPointer = (key: string) => readJson<Pointer>(file(key));
export const savePointer = (p: Pointer) => writeJson(file(p.key), p);
export const removePointer = (key: string) => removeFile(file(key));
export const pointerKeys = () => listJson(dir());
export const listPointers = () => pointerKeys().map((k) => loadPointer(k)!).filter(Boolean);
export function bindSession(key: string, workset: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  p.workset = workset; savePointer(p); return p;
}
// Afterwards `name` lists `key` in its sessions. Worksets are made by hand (`workset create`, `adopt`), never here.
export function joinWorkset(key: string, name: string): Workset {
  const ws = loadWorkset(name); if (!ws) throw new Error(`workbench: no workset "${name}"; create it first`);
  if (!ws.sessions.includes(key)) { ws.sessions.push(key); saveWorkset(ws); }
  return ws;
}
// Rebinds the session to `name`: it joins `name` and leaves the workset its pointer named before.
export function useWorkset(key: string, name: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  joinWorkset(key, name); // first: it throws on a missing workset
  const prev = p.workset && p.workset !== name ? loadWorkset(p.workset) : null;
  if (prev?.sessions.includes(key)) { prev.sessions = prev.sessions.filter((k) => k !== key); saveWorkset(prev); }
  return bindSession(key, name);
}
// Clears the binding: the session leaves its workset's session list and receives no more reviews. The workset stays.
export function unbindWorkset(key: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  const prev = p.workset ? loadWorkset(p.workset) : null;
  if (prev?.sessions.includes(key)) { prev.sessions = prev.sessions.filter((k) => k !== key); saveWorkset(prev); }
  p.workset = null; savePointer(p); return p;
}
export const currentWorkset = (key: string) => loadPointer(key)?.workset ?? null;
export function openPointer(harness: string, session: string, cwd: string): Pointer {
  const key = pointerKey(harness, session);
  const existing = loadPointer(key);
  if (existing) { existing.closed = null; existing.cwd = cwd; savePointer(existing); return existing; }
  const p: Pointer = { key, harness, session, workset: null, cwd, opened: now(), closed: null };
  savePointer(p); return p;
}
export function closePointer(key: string): Pointer | null {
  const p = loadPointer(key); if (!p) return null; p.closed = now(); savePointer(p); return p;
}
export function pointerState(p: Pointer, nowMs = Date.now()): PointerState {
  if (p.closed) return "closed";
  // Liveness feeds deletion, so it fails open: no transcript found counts as open.
  if (p.harness === "claude") return isAlive(p.cwd, p.session, nowMs) === "stale" ? "stale" : "open";
  return "open";
}
export function closeStale(p: Pointer): Pointer {
  p.closed = now(); p.closed_reason = "stale"; savePointer(p); return p;
}
