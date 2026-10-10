import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { derive, foundId, prunable, unclaimed, type Found } from "../derive";
import { listWorksets, loadWorkset, type Workset } from "../workset";

const line = (f: Found) =>
  `${foundId(f)}  ${f.worktree ?? "-"}  ${f.pr ? `PR #${f.pr.number} ${f.pr.state}${f.pr.draft ? " draft" : ""}` : "no PR"}`;

export async function run(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, allowPositionals: false, options: { json: { type: "boolean" } } });
    const found = derive(loadConfig());
    const worksets = listWorksets().map(loadWorkset).filter((w): w is Workset => !!w);
    const open = new Set(unclaimed(found, worksets).map(foundId));
    const claimed = found.filter((f) => !open.has(foundId(f))).flatMap((f) => {
      const ws = worksets.find((w) => w.members.some((m) => m.id === foundId(f)));
      return ws ? [{ found: f, workset: ws.name }] : []; // ignored ids are neither claimed nor unclaimed
    });
    const loose = found.filter((f) => open.has(foundId(f)));
    const pr = prunable(loose);
    if (values.json) {
      console.log(JSON.stringify({ claimed, unclaimed: loose, prunable: pr }, null, 2));
      return 0;
    }
    for (const name of [...new Set(claimed.map((c) => c.workset))]) {
      console.log(`claimed (${name})`);
      for (const c of claimed.filter((x) => x.workset === name)) console.log(`  ${line(c.found)}`);
    }
    console.log("unclaimed");
    for (const f of loose) console.log(`  ${line(f)}`);
    console.log("prunable");
    for (const p of pr) console.log(`  ${line(p.found)}  (${p.reason})`);
    return 0;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) { console.error(`workbench: ${(e as Error).message}`); return 2; }
    console.error((e as Error).message);
    return 1;
  }
}
