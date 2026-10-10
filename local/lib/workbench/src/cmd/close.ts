import { parseArgs } from "node:util";
import { closeReview, closedLine } from "../submit";

const fail = (msg: string, code = 1) => { console.error(msg); return code; };

export async function run(args: string[]): Promise<number> {
  try {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    if (positionals.length !== 1) return fail("usage: workbench close <workset>", 2);
    console.log(closedLine(positionals[0], closeReview(positionals[0])));
    return 0;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
