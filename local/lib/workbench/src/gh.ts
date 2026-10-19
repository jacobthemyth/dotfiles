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

export let lastGhError: string | null = null;
export const BATCH = 50;
export type BranchPr = { pr: Pr; base: string; headRefOid: string };

export function buildBranchQuery(owner: string, repo: string, branches: string[]): string {
  const fields = branches.map((b, i) =>
    `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, states: [OPEN, MERGED, CLOSED], last: 1, orderBy: {field: CREATED_AT, direction: ASC}) { nodes { number url isDraft state baseRefName headRefOid } }`);
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${fields.join(" ")} } }`;
}

export function parseBranchResponse(branches: string[], json: unknown): Map<string, BranchPr> | null {
  const out = new Map<string, BranchPr>();
  const repo = (json as { data?: { repository?: Record<string, { nodes?: (Raw & { headRefOid: string })[] } | null> } } | null)?.data?.repository;
  if (!repo) return null;
  branches.forEach((b, i) => {
    const n = repo[`b${i}`]?.nodes?.[0];
    if (n) out.set(b, { pr: toPr(n), base: n.baseRefName, headRefOid: n.headRefOid });
  });
  return out;
}

export function prsForBranches(slug: string, branches: string[], deps: { run?: (query: string) => unknown } = {}): Map<string, BranchPr> {
  lastGhError = null;
  const s = stub<Record<string, BranchPr | Record<string, BranchPr>>>("prsForBranches");
  if (s) {
    // Keyed by slug then branch; a flat branch map (every value a BranchPr) serves every slug.
    const v = s.value ?? {};
    const flat = Object.values(v).every((x) => x && typeof x === "object" && "pr" in x);
    const map = (flat ? v : v[slug] ?? {}) as Record<string, BranchPr>;
    return new Map(Object.entries(map));
  }
  const [owner, repo] = slug.split("/");
  const run = deps.run ?? ((q: string) => gh("api", "graphql", "-f", `query=${q}`));
  const out = new Map<string, BranchPr>();
  for (let i = 0; i < branches.length; i += BATCH) {
    const chunk = branches.slice(i, i + BATCH);
    const json = run(buildBranchQuery(owner, repo, chunk));
    if (json == null) { lastGhError = "gh api graphql failed"; return new Map(); }
    const parsed = parseBranchResponse(chunk, json);
    if (!parsed) {
      const msg = (json as { errors?: { message?: string }[] })?.errors?.[0]?.message;
      lastGhError = `gh api graphql returned no repository${msg ? `: ${msg}` : ""}`;
      return new Map();
    }
    for (const [k, v] of parsed) out.set(k, v);
  }
  return out;
}
