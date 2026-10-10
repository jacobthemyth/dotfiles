import { isAbsolute, join } from "node:path";

export type Recorded =
  | { kind: "worktree"; path: string; branch: string | null }
  | { kind: "push"; branch: string }
  | { kind: "pr"; prUrl: string };

function words(seg: string): string[] {
  const w = seg.trim().split(/\s+/).filter(Boolean);
  return w[0] === "rtk" ? w.slice(1) : w;
}

export function recognise(command: string, output: string, cwd: string): Recorded[] {
  const out: Recorded[] = [];
  for (const seg of command.split(/&&|\|\||;|\n/)) {
    const w = words(seg).filter((x) => !x.startsWith("-c") || x.length > 2);
    const gi = w.findIndex((x) => x === "git" || x.endsWith("/git"));
    if (gi >= 0 && w[gi + 1] === "worktree" && w[gi + 2] === "add") {
      const rest = w.slice(gi + 3);
      const bi = rest.indexOf("-b");
      const branch = bi >= 0 ? rest[bi + 1] : null;
      const pos = rest.filter((x, i) => !x.startsWith("-") && (bi < 0 || (i !== bi && i !== bi + 1)));
      if (pos[0]) out.push({ kind: "worktree", path: isAbsolute(pos[0]) ? pos[0] : join(cwd, pos[0]), branch });
    } else if (gi >= 0 && w[gi + 1] === "push" && (w.includes("-u") || w.includes("--set-upstream"))) {
      const pos = w.slice(gi + 2).filter((x) => !x.startsWith("-"));
      const ref = pos[1];
      if (ref) out.push({ kind: "push", branch: ref.split(":").pop()! });
    } else if (w[0] === "gh" && w[1] === "pr" && w[2] === "create") {
      const m = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/);
      if (m) out.push({ kind: "pr", prUrl: m[0] });
    }
  }
  return out;
}
