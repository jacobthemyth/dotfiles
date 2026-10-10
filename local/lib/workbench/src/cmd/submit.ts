import { parseArgs } from "node:util";
import { submitReview } from "../submit";

const USAGE = "usage: workbench submit <workset> [--message <m>]";
const fail = (msg: string, code = 1) => { console.error(msg); return code; };

export async function run(args: string[]): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { message: { type: "string", short: "m" } } });
    if (positionals.length !== 1) return fail(USAGE, 2);
    await submitReview(positionals[0], { message: values.message });
    return 0;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
