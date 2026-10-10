import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

test("loads config and expands ~ in roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, 'repo_roots = ["~/Code/x/*"]\nworktree_dirs = [".worktrees"]\nexclude_repos = []\ngithub_user = "@me"\nharnesses = ["claude"]\ndefault_branch = "main"\n');
  process.env.WORKBENCH_CONFIG = p;
  const c = loadConfig();
  expect(c.repo_roots[0]).toBe(join(process.env.HOME!, "Code/x/*"));
  expect(c.default_branch).toBe("main");
});

test("missing config fails with the path in the message", () => {
  process.env.WORKBENCH_CONFIG = "/nonexistent/config.toml";
  expect(() => loadConfig()).toThrow("/nonexistent/config.toml");
});
