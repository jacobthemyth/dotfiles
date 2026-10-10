import { join } from "node:path";
import { sub } from "./paths";
import { readJson, writeJson, now, listJson } from "./store";
import { createWorkset, loadWorkset, saveWorkset, type Workset } from "./workset";

export type Pointer = { key: string; harness: string; session: string; workset: string; cwd: string; opened: string; closed: string | null };
const dir = () => sub("sessions");
export const pointerKey = (harness: string, session: string) => `${harness}-${session}`;
const file = (key: string) => join(dir(), `${key}.json`);
export const loadPointer = (key: string) => readJson<Pointer>(file(key));
export const savePointer = (p: Pointer) => writeJson(file(p.key), p);
export const pointerKeys = () => listJson(dir());
export const listPointers = () => pointerKeys().map((k) => loadPointer(k)!).filter(Boolean);
export function bindSession(key: string, workset: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  p.workset = workset; savePointer(p); return p;
}
// The one create-or-join step: afterwards `name` exists and lists `key` in its sessions.
export function joinWorkset(key: string, name: string): Workset {
  const ws = loadWorkset(name) ?? createWorkset(name, key);
  if (!ws.sessions.includes(key)) { ws.sessions.push(key); saveWorkset(ws); }
  return ws;
}
// Rebinds the session to `name`: it joins `name` and leaves the workset its pointer named before.
export function useWorkset(key: string, name: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  joinWorkset(key, name); // first: it throws on an invalid name
  const prev = p.workset !== name ? loadWorkset(p.workset) : null;
  if (prev?.sessions.includes(key)) { prev.sessions = prev.sessions.filter((k) => k !== key); saveWorkset(prev); }
  return bindSession(key, name);
}
export const currentWorkset = (key: string) => loadPointer(key)?.workset ?? null;
export function openPointer(harness: string, session: string, cwd: string): Pointer {
  const key = pointerKey(harness, session);
  const existing = loadPointer(key);
  if (existing) { existing.closed = null; existing.cwd = cwd; savePointer(existing); return existing; }
  const p: Pointer = { key, harness, session, workset: key, cwd, opened: now(), closed: null };
  savePointer(p); return p;
}
export function closePointer(key: string): Pointer | null {
  const p = loadPointer(key); if (!p) return null; p.closed = now(); savePointer(p); return p;
}
