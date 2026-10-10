import { parseArgs } from "node:util";
import { addReply } from "../reply";
import { sessionKeyFromEnv } from "../session-key";

const USAGE = "usage: workbench reply --review <id> --comment <comment-id> --text <text> [--session <key>]";
const fail = (msg: string, code = 1) => { console.error(msg); return code; };

export async function run(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { review: { type: "string" }, comment: { type: "string" }, text: { type: "string" }, session: { type: "string" } } });
    if (!values.review || !values.comment || !values.text?.trim()) return fail(USAGE, 2);
    const key = sessionKeyFromEnv(values);
    if (!key) return fail("workbench: no session key; set WORKBENCH_SESSION or pass --session <key>", 2);
    const { shown } = addReply(key, values.review, values.comment, values.text.trim());
    console.log(`replied to ${values.comment} in ${values.review}${shown ? " (shown in the reviewer)" : ""}`);
    return 0;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
