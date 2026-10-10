#!/usr/bin/env bun
export {};
const [group, ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<(args: string[]) => Promise<number>>> = {
  config: async () => (await import("./cmd/config")).run,
  workset: async () => (await import("./cmd/workset")).run,
};
const load = commands[group ?? ""];
if (!load) { console.error("usage: workbench <config|workset|hook|scan|open|submit|close|inbox|reply> ..."); process.exit(2); }
process.exit(await (await load())(rest));
