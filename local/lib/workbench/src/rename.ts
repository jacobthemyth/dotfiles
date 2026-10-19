import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { sub } from "./paths";
import { loadLock } from "./review";
import { listPointers, savePointer } from "./session";
import { readJson, writeJson } from "./store";
import { deleteWorkset, isValidName, loadWorkset, saveWorkset } from "./workset";

// Naming a workset is how it is pinned. Order matters for crashes: the workset file moves first, so a crash leaves at worst a
// workset with no pointers, never pointers to a missing workset.
export function renameWorkset(from: string, to: string): void {
  const ws = loadWorkset(from);
  if (!ws) throw new Error(`workbench: no workset "${from}"`);
  if (!isValidName(to)) throw new Error(`workbench: invalid workset name "${to}"`);
  if (loadWorkset(to)) throw new Error(`workbench: workset "${to}" exists`);
  if (loadLock(from)) throw new Error(`workbench: "${from}" has an open review; close or submit it first`);
  const reviews = join(sub("reviews"), from), reviewsTo = join(sub("reviews"), to);
  if (existsSync(reviewsTo)) throw new Error(`workbench: reviews/${to} already exists; remove or rename it first`);
  saveWorkset({ ...ws, name: to });
  deleteWorkset(from);
  for (const p of listPointers()) if (p.workset === from) savePointer({ ...p, workset: to });
  if (existsSync(reviews)) renameSync(reviews, reviewsTo);
  const inbox = sub("inbox");
  if (!existsSync(inbox)) return;
  for (const key of readdirSync(inbox)) {
    const keyDir = join(inbox, key);
    if (!statSync(keyDir).isDirectory()) continue;
    for (const f of readdirSync(keyDir).filter((n) => n.endsWith(".json"))) {
      const path = join(keyDir, f);
      let r: { workset?: string } | null;
      try { r = readJson<{ workset?: string }>(path); } catch { continue; }
      if (r?.workset === from) writeJson(path, { ...r, workset: to });
    }
  }
}
