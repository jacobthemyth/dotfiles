import { spawnSync } from "node:child_process";
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

export type WorktreeEntry = { path: string; branch: string | null; detached: boolean };
// The repo's worktrees, main first; null when `git worktree list` fails.
export function worktreeList(repo: string): WorktreeEntry[] | null {
  const r = exec(repo, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return null;
  const list: WorktreeEntry[] = [];
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) list.push({ path: line.slice(9), branch: null, detached: false });
    else if (line.startsWith("branch ") && list.length) list[list.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached" && list.length) list[list.length - 1].detached = true;
  }
  return list;
}
export const worktrees = (repo: string): WorktreeEntry[] => worktreeList(repo) ?? [];

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
// The upstream of a local branch (`origin/main`), or null when it has none, it is gone, or `branch` is not a local branch.
export function upstreamOf(cwd: string, branch: string): string | null {
  const out = git(cwd, "for-each-ref", "--format=%(upstream:short)|%(upstream:track)", `refs/heads/${branch}`);
  if (!out) return null;
  const [upstream, track = ""] = out.split("|");
  return upstream && track !== "[gone]" ? upstream : null;
}

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

// Commits ahead of the upstream; null when there is no upstream, it is gone, or git fails.
export function aheadOfUpstream(repo: string, branch: string): number | null {
  const out = git(repo, "for-each-ref", "--format=%(upstream)|%(upstream:track)", `refs/heads/${branch}`);
  if (!out) return null;
  const [upstream, track = ""] = out.split("|");
  if (!upstream || track === "[gone]") return null;
  const m = track.match(/ahead (\d+)/);
  return m ? Number(m[1]) : 0;
}
export function revListCount(repo: string, range: string): number | null {
  const out = git(repo, "rev-list", "--count", range);
  return out === null ? null : Number(out);
}
export const hasCommit = (repo: string, oid: string) => exec(repo, ["cat-file", "-e", `${oid}^{commit}`]).ok;
export const isAncestor = (repo: string, ancestor: string, descendant: string) => exec(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
// Best effort: brings a PR's head commit into the local object store. Never prompts; gives up after 20 s.
export function fetchPullHead(repo: string, number: number): boolean {
  try {
    const r = spawnSync("git", ["fetch", "-q", "origin", `refs/pull/${number}/head`], {
      cwd: repo, timeout: 20_000, stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    });
    return r.status === 0;
  } catch { return false; }
}
