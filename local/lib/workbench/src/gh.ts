import { readFileSync } from "node:fs";
import type { Pr } from "./workset";
import { loadConfig } from "./config";

export type PrWithBranch = { pr: Pr; branch: string; base: string };

// Read-only: only `pr view`, `pr list`, `repo view` are ever run.
function stub<T>(fn: string): { value: T } | null {
  const f = process.env.WORKBENCH_GH_STUB;
  if (!f) return null;
  return { value: JSON.parse(readFileSync(f, "utf8"))[fn] as T };
}

function gh(...args: string[]): unknown {
  try {
    const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? JSON.parse(r.stdout.toString()) : null;
  } catch { return null; }
}

type Raw = { number: number; url: string; isDraft: boolean; state: string; headRefName?: string; baseRefName: string };
const toPr = (r: Raw): Pr => ({ number: r.number, url: r.url, draft: r.isDraft, state: r.state });

export function prForBranch(slug: string, branch: string): { pr: Pr; base: string } | null {
  const s = stub<{ pr: Pr; base: string } | null>("prForBranch"); if (s) return s.value ?? null;
  const r = gh("pr", "view", branch, "--repo", slug, "--json", "number,url,isDraft,state,baseRefName") as Raw | null;
  return r ? { pr: toPr(r), base: r.baseRefName } : null;
}

export function prBase(slug: string, number: number): string {
  const s = stub<string>("prBase"); if (s) return s.value;
  const r = gh("pr", "view", String(number), "--repo", slug, "--json", "baseRefName") as Raw | null;
  return r?.baseRefName ?? "main";
}

export function myPrs(slug: string): PrWithBranch[] {
  const s = stub<PrWithBranch[]>("myPrs"); if (s) return s.value ?? [];
  const r = gh("pr", "list", "--repo", slug, "--author", loadConfig().github_user, "--state", "all", "--limit", "100",
    "--json", "number,url,isDraft,state,headRefName,baseRefName") as Raw[] | null;
  return (r ?? []).map((x) => ({ pr: toPr(x), branch: x.headRefName!, base: x.baseRefName }));
}
