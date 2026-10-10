import { existsSync, readFileSync } from "node:fs";
import { configPath, expandHome } from "./paths";

export type Config = {
  repo_roots: string[]; worktree_dirs: string[]; exclude_repos: string[];
  github_user: string; harnesses: string[]; default_branch: string;
};

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) throw new Error(`workbench: config not found at ${p}`);
  const raw = Bun.TOML.parse(readFileSync(p, "utf8")) as Partial<Config>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map(expandHome) : []);
  return {
    repo_roots: list(raw.repo_roots),
    worktree_dirs: list(raw.worktree_dirs),
    exclude_repos: list(raw.exclude_repos),
    github_user: raw.github_user ?? "@me",
    harnesses: Array.isArray(raw.harnesses) ? raw.harnesses.map(String) : ["claude"],
    default_branch: raw.default_branch ?? "main",
  };
}
