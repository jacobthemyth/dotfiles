import { parseArgs } from "node:util";
import * as inbox from "../inbox";
import { renderMarkdown } from "../render";
import { findArchived } from "../resolve";
import { sessionKeyFromEnv } from "../session-key";
import type { ReviewFile } from "../submit";

const USAGE = `usage: workbench inbox <subcommand> [--session <key>]
  list
  show [id]
  wait [--timeout <seconds>]`;
const fail = (msg: string, code = 1) => { console.error(msg); return code; };

export const arrivalLine = (r: ReviewFile, key: string) =>
  `workbench: a review arrived for workset "${r.workset}" (${r.comments.length} comments, ${r.edits.length} edit commits). Run \`workbench inbox show --session ${key}\` and follow the workbench-review skill.`;

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { session: { type: "string" }, timeout: { type: "string" } } });
    const key = sessionKeyFromEnv(values);
    if (!["list", "show", "wait"].includes(sub ?? "")) return fail(USAGE, 2);
    if (!key) return fail("workbench: no session key; set WORKBENCH_SESSION or pass --session <key>", 2);
    switch (sub) {
      case "list": {
        for (const r of inbox.list(key)) console.log(`${r.read ? " " : "*"} ${r.id}  ${r.submitted}  ${r.workset}  ${r.comments.length} comments`);
        return 0;
      }
      case "show": {
        const all = inbox.list(key);
        const r = positionals[0] ? inbox.get(key, positionals[0]) : (all.find((x) => !x.read) ?? all.sort((a, b) => b.submitted.localeCompare(a.submitted))[0]);
        if (!r) return fail(positionals[0] ? `workbench: no review "${positionals[0]}" in ${key}` : `workbench: no reviews for ${key}`);
        process.stdout.write(renderMarkdown(r, (id) => findArchived(r.workset, id)));
        inbox.markRead(key, r.id);
        return 0;
      }
      default: {
        const secs = values.timeout === undefined ? 7200 : Number(values.timeout);
        if (!Number.isFinite(secs) || secs < 0) return fail("workbench: --timeout must be a number of seconds", 2);
        const r = await inbox.wait(key, secs * 1000);
        if (!r) return 0;
        console.error(arrivalLine(r, key));
        return 2;
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
