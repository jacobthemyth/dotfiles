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

const GIT_OPTS = String.raw`(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?|\s+-\w)*`;
const WRITE_RES = [
  new RegExp(String.raw`\bgit${GIT_OPTS}\s+(commit|rebase|reset|checkout|switch|merge|cherry-pick|stash|apply|am|push|mv|rm|clean|restore)\b`),
  /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
  /\b(rm|mv|cp|tee|truncate|chmod|chown)\b/,
  /\bterraform\s+(apply|state|import)\b/,
];
export function looksLikeWrite(command: string): boolean {
  const stripped = command
    .replace(/\d*>&\d*-?/g, " ")             // 2>&1
    .replace(/(?:&|\d*)>>?\s*\/dev\/null\b/g, " "); // > /dev/null, 2>/dev/null, &>/dev/null
  if (/(^|[^<=-])>/.test(stripped)) return true;
  return WRITE_RES.some((re) => re.test(command));
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
