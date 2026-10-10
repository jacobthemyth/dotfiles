import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { sub } from "./paths";
import type { Lock } from "./review";

// Plain fs only: this runs on every tool call, so no git and no network, and nothing may throw.

export function activeLocks(): Lock[] {
  const dir = sub("locks");
  let files: string[];
  try { files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []; } catch { return []; }
  const out: Lock[] = [];
  for (const f of files) {
    try {
      const l = JSON.parse(readFileSync(join(dir, f), "utf8")) as Lock;
      if (l && typeof l.workset === "string" && Array.isArray(l.paths) && l.paths.every((p) => typeof p === "string")) out.push(l);
    } catch { /* skip unparseable lock */ }
  }
  return out;
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
const under = (p: string, base: string): boolean => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);
// Match on realpath when it exists, else on the normalised string; accept either side matching.
const within = (p: string, lockPath: string): boolean => {
  const a = [resolve(p), real(p)], b = [resolve(lockPath), real(lockPath)];
  return a.some((x) => b.some((y) => under(x, y)));
};

/** The lock path (as stored) that `path` is equal to or under, with its lock. */
export function lockFor(path: string): (Lock & { matched: string }) | null {
  for (const l of activeLocks()) for (const p of l.paths) if (within(path, p)) return { ...l, matched: p };
  return null;
}

export function denyMessage(lock: Lock, path: string): string {
  return `workbench: ${path} is locked by review ${lock.review} of workset ${lock.workset} (held by ${lock.holder}); it is released on submit or close. Work elsewhere until then.`;
}

const PREFIXES = new Set(["sudo", "env", "command", "exec", "time", "nice", "nohup", "xargs"]);
const VERBS = new Set(["rm", "mv", "cp", "tee", "truncate", "chmod", "chown", "dd", "rsync"]);
const GIT_WRITES = new Set(["commit", "rebase", "reset", "checkout", "switch", "merge", "cherry-pick", "apply", "am", "push", "mv", "rm", "clean", "restore", "worktree", "branch", "tag"]);
const STASH_WRITES = new Set(["push", "pop", "apply", "drop", "clear", "save"]);

function gitWrites(rest: string[]): boolean {
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) i += rest[i] === "-C" || rest[i] === "-c" ? 2 : 1;
  const sub = rest[i];
  if (sub === undefined) return false;
  if (sub === "stash") return rest[i + 1] === undefined || STASH_WRITES.has(rest[i + 1]);
  return GIT_WRITES.has(sub);
}
function segmentWrites(seg: string): boolean {
  const toks = seg.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && (PREFIXES.has(toks[i]) || /^[A-Za-z_]\w*=/.test(toks[i]) || (i > 0 && toks[i].startsWith("-")))) i++;
  const head = toks[i];
  if (head === undefined) return false;
  const rest = toks.slice(i + 1);
  if (VERBS.has(head)) return true;
  if (head === "sed") return rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith("--in-place"));
  if (head === "git") return gitWrites(rest);
  if (head === "terraform") return ["apply", "state", "import"].includes(rest[0]);
  return false;
}
export function looksLikeWrite(command: string): boolean {
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  const noRedir = bare
    .replace(/\d*>&\d*-?/g, " ")
    .replace(/(?:&|\d*)>>?\s*\/dev\/null\b/g, " ")
    .replace(/->|=>|<>|>=/g, " ");
  if (/(^|[^<])>/.test(noRedir)) return true;
  return bare.split(/&&|\|\||;|\||\n/).some(segmentWrites);
}

const unquote = (t: string) => t.replace(/^["']+|["']+$/g, "");
const expand = (t: string) => (t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t);

/** The first lock path the command's effective cwd or path-like tokens fall under, else null. */
export function commandTouches(command: string, cwd: string, lockPaths: string[]): string | null {
  const hit = (p: string): string | null => lockPaths.find((lp) => within(p, lp)) ?? null;
  let eff = resolve(cwd);
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean).map(unquote);
    if (toks.length === 0) continue;
    const check = (p: string) => hit(resolve(eff, expand(p)));
    let found = hit(eff);
    if (found) return found;
    if (toks[0] === "cd") {
      const arg = toks.slice(1).find((t) => t !== "--");
      if (arg !== "-") eff = arg === undefined ? homedir() : resolve(eff, expand(arg));
      found = hit(eff);
      if (found) return found;
      continue;
    }
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === "-C" && toks[i + 1] !== undefined && (found = check(toks[i + 1]))) return found;
      const cands = [t.replace(/^\d*>>?/, "").replace(/^&>/, "")];
      if (t.includes("=")) cands.push(t.slice(t.indexOf("=") + 1));
      for (const c of cands) if (c && (found = check(unquote(c)))) return found;
    }
  }
  return null;
}
