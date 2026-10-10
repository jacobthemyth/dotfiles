import type { Config } from "./config";
import type { BaseSource, Member } from "./workset";

export function diffBase(m: Member, config: Config): string { return m.base ?? config.default_branch; }
export function baseSource(m: Member): BaseSource { return m.base_source ?? (m.base ? "declared" : "default"); }

// Depth in the base chain: 0 when the base is not another member's branch (in the same repo).
function depths(members: Member[]): Map<Member, number> {
  const byBranch = new Map(members.map((m) => [m.branch, m]));
  const out = new Map<Member, number>();
  for (const m of members) {
    const seen = new Set<Member>([m]);
    let d = 0, cur = m;
    for (;;) {
      const next = cur.base ? byBranch.get(cur.base) : undefined;
      if (!next || seen.has(next)) break;
      seen.add(next); d++; cur = next;
    }
    out.set(m, d);
  }
  return out;
}

const byRepo = (members: Member[]) => {
  const groups = new Map<string, Member[]>();
  for (const m of members) groups.set(m.repo, [...(groups.get(m.repo) ?? []), m]);
  return groups;
};

export function orderMembers(members: Member[]): Member[] {
  const out: Member[] = [];
  for (const group of byRepo(members).values()) {
    const d = depths(group);
    const explicit = group.filter((m) => m.order !== null).sort((a, b) => a.order! - b.order!);
    const rest = group.filter((m) => m.order === null)
      .sort((a, b) => d.get(a)! - d.get(b)! || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
    out.push(...explicit, ...rest);
  }
  return out;
}

export type StackNode = { repo: string; slug: string | null; bottomBase: string; top: Member };

export function stackNodes(members: Member[], config: Config): StackNode[] {
  const nodes: StackNode[] = [];
  for (const [repo, group] of byRepo(members)) {
    if (group.length < 2) continue;
    const d = depths(group);
    const linked = group.filter((m) => d.get(m)! > 0 || group.some((o) => o !== m && o.base === m.branch));
    if (linked.length < 2) continue;
    const sorted = [...linked].sort((a, b) => d.get(a)! - d.get(b)! || (a.branch < b.branch ? -1 : 1));
    const bottom = sorted[0], top = sorted[sorted.length - 1];
    nodes.push({ repo, slug: top.slug, bottomBase: diffBase(bottom, config), top });
  }
  return nodes;
}
