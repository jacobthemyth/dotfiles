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

// One node per connected component of base links within a repo. A fork (a->b, a->c) is one
// component: its members are ordered, not branched, so the top is the last in that order.
export function stackNodes(members: Member[], config: Config): StackNode[] {
  const nodes: StackNode[] = [];
  for (const [repo, group] of byRepo(members)) {
    const parent = new Map(group.map((m) => [m, m]));
    const find = (m: Member): Member => { while (parent.get(m) !== m) m = parent.get(m)!; return m; };
    for (const m of group) {
      const target = m.base ? group.find((o) => o !== m && o.branch === m.base) : undefined;
      if (target) parent.set(find(m), find(target));
    }
    const comps = new Map<Member, Member[]>();
    for (const m of group) comps.set(find(m), [...(comps.get(find(m)) ?? []), m]);
    for (const comp of comps.values()) {
      if (comp.length < 2) continue;
      const ordered = orderMembers(comp);
      const top = ordered[ordered.length - 1];
      nodes.push({ repo, slug: top.slug, bottomBase: diffBase(ordered[0], config), top });
    }
  }
  return nodes;
}
