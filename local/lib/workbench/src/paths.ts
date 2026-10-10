import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p === "~" ? homedir() : p;
}
export function stateDir(): string {
  return process.env.WORKBENCH_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "workbench");
}
export function configPath(): string {
  return process.env.WORKBENCH_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "workbench/config.toml");
}
export const sub = (name: string) => join(stateDir(), name);
