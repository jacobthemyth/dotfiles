#!/usr/bin/env bun
export {};
const [group, ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<(args: string[]) => Promise<number>>> = {
  config: async () => (await import("./cmd/config")).run,
  workset: async () => (await import("./cmd/workset")).run,
  scan: async () => (await import("./cmd/scan")).run,
  hook: async () => (await import("./cmd/hook")).run,
  open: async () => (await import("./cmd/open")).run,
  sidebar: async () => (await import("./cmd/sidebar")).run,
  submit: async () => (await import("./cmd/submit")).run,
  close: async () => (await import("./cmd/close")).run,
  inbox: async () => (await import("./cmd/inbox")).run,
  reply: async () => (await import("./cmd/reply")).run,
  "edit-guard": async () => (await import("./cmd/edit-guard")).run,
};
const load = commands[group ?? ""];
if (!load) { console.error("usage: workbench <config|workset|hook|scan|open|sidebar|submit|close|inbox|reply|edit-guard> ..."); process.exit(2); }
process.exit(await (await load())(rest));
