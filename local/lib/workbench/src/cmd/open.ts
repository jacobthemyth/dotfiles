import { parseArgs } from "node:util";
import { openReview } from "../review";
import * as tmux from "../tmux";

const USAGE = "usage: workbench open <workset> [--allow-dirty] [--no-attach]";
const fail = (msg: string, code = 1) => { console.error(msg); return code; };

export async function run(args: string[]): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args, allowPositionals: true, options: { "allow-dirty": { type: "boolean" }, "no-attach": { type: "boolean" } },
    });
    if (positionals.length !== 1) return fail(USAGE, 2);
    const r = openReview(positionals[0], { allowDirty: !!values["allow-dirty"] });
    const session = tmux.sessionName(r.workset);
    if (values["no-attach"]) { console.log(`${r.id} ${session}`); return 0; }
    return tmux.switchOrAttach(session) === 0 ? 0 : fail(`workbench: could not attach to ${session}`);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
