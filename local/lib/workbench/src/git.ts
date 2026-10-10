function git(cwd: string, ...args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch { return null; }
}

export const repoRoot = (cwd: string) => git(cwd, "rev-parse", "--show-toplevel") || null;
export const currentBranch = (cwd: string) => git(cwd, "symbolic-ref", "--short", "-q", "HEAD") || null;
export const isDirty = (path: string) => !!git(path, "status", "--porcelain");
export const revParse = (path: string, ref: string) => git(path, "rev-parse", ref);

export function remoteSlug(cwd: string): string | null {
  const url = git(cwd, "remote", "get-url", "origin");
  const m = url?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

export function worktrees(repo: string): { path: string; branch: string | null }[] {
  const out = git(repo, "worktree", "list", "--porcelain");
  if (!out) return [];
  const list: { path: string; branch: string | null }[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) list.push({ path: line.slice(9), branch: null });
    else if (line.startsWith("branch ") && list.length) list[list.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return list;
}

export function mainWorktree(repo: string): string {
  return worktrees(repo)[0]?.path ?? repo;
}

export function defaultBranch(repo: string): string {
  const head = git(repo, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD");
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) if (git(repo, "rev-parse", "--verify", "-q", `refs/heads/${b}`)) return b;
  return "main";
}
