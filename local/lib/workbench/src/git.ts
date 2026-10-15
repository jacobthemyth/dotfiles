function exec(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) { return { ok: false, out: "", err: (e as Error).message }; }
}
function git(cwd: string, ...args: string[]): string | null {
  const r = exec(cwd, args);
  return r.ok ? r.out : null;
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

// Every local branch and its tip; null when `repo` is not a repository.
export function heads(repo: string): Record<string, string> | null {
  const out = git(repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads");
  if (out === null) return null;
  const map: Record<string, string> = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(" ");
    map[ref.replace(/^refs\/heads\//, "")] = sha;
  }
  return map;
}

// Local branches whose tips are `rev` or its ancestors.
export function mergedInto(repo: string, rev: string): string[] {
  const out = git(repo, "for-each-ref", `--merged=${rev}`, "--format=%(refname)", "refs/heads");
  return out ? out.split("\n").filter(Boolean).map((r) => r.replace(/^refs\/heads\//, "")) : [];
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

export function upstreamGone(repo: string, branch: string): boolean {
  return git(repo, "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`) === "[gone]";
}

export function commonDir(path: string): string | null {
  const d = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return d || null;
}

// The only destructive git command in workbench. Callers must have checked prunable-ness and
// that nothing claims the item. Removes the worktree (if any), then force-deletes the branch.
export function pruneWorktreeAndBranch(repo: string, worktree: string | null, branch: string): boolean {
  if (worktree && git(repo, "worktree", "remove", worktree) === null) return false;
  return git(repo, "branch", "-D", branch) !== null;
}

// Paths (relative to the worktree) with uncommitted changes, untracked included; null on failure.
export function dirtyFiles(path: string): string[] | null {
  try {
    const r = Bun.spawnSync(["git", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd: path, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    const out: string[] = [];
    const parts = r.stdout.toString().split("\0");
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      out.push(e.slice(3));
      if (e[0] === "R" || e[0] === "C") i++; // the next field is the rename/copy source
    }
    return out;
  } catch { return null; }
}

export const mergeBase = (cwd: string, a: string, b: string) => git(cwd, "merge-base", a, b);

const zList = (out: string | null) => (out === null ? null : out.split("\0").filter(Boolean));
// Tracked paths that differ from HEAD (staged or not, deletions included); null on failure.
export const diffNames = (path: string) => zList(git(path, "diff", "--name-only", "-z", "HEAD"));
export const untracked = (path: string) => zList(git(path, "ls-files", "--others", "--exclude-standard", "-z"));
// add and commit return null on success, else git's error text.
const errOf = (r: { ok: boolean; err: string }, what: string) => (r.ok ? null : r.err || `git ${what} failed`);
export const add = (path: string, files: string[]) => errOf(exec(path, ["add", "--", ...files]), "add");
// Commits exactly `files` (--only semantics: anything else already staged stays staged and out).
export function commit(path: string, message: string, trailers: string[], files: string[]): string | null {
  return errOf(exec(path, ["commit", "-q", "-m", message, ...trailers.flatMap((t) => ["--trailer", t]), "--", ...files]), "commit");
}
// Takes `files` back out of the index; no commit is touched.
export const unstage = (path: string, files: string[]) => git(path, "restore", "--staged", "--", ...files) !== null;
