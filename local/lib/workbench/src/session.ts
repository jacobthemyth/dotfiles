import { join } from "node:path";
import { sub } from "./paths";
import { readJson, writeJson, now, listJson } from "./store";

export type Pointer = { key: string; harness: string; session: string; workset: string; cwd: string; opened: string; closed: string | null };
const dir = () => sub("sessions");
export const pointerKey = (harness: string, session: string) => `${harness}-${session}`;
const file = (key: string) => join(dir(), `${key}.json`);
export const loadPointer = (key: string) => readJson<Pointer>(file(key));
export const savePointer = (p: Pointer) => writeJson(file(p.key), p);
export const listPointers = () => listJson(dir()).map((k) => loadPointer(k)!).filter(Boolean);
export function bindSession(key: string, workset: string): Pointer {
  const p = loadPointer(key); if (!p) throw new Error(`workbench: no session ${key}`);
  p.workset = workset; savePointer(p); return p;
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
