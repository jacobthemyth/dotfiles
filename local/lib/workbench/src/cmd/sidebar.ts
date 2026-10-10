import { parseArgs } from "node:util";

const fail = (msg: string, code = 1) => { console.error(msg); return code; };

export async function run(args: string[]): Promise<number> {
  try {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    if (positionals.length !== 1) return fail("usage: workbench sidebar <workset>", 2);
    return await (await import("../sidebar")).runSidebar(positionals[0]);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
