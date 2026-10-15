// Branches and worktrees are observed from git state (observe.ts). These two carry what a
// snapshot cannot see: an existing branch the session published, and the PR it opened.
export type Recorded =
  | { kind: "push"; branch: string }
  | { kind: "pr"; prUrl: string };

function words(seg: string): string[] {
  const w = seg.trim().split(/\s+/).filter(Boolean);
  return w[0] === "rtk" ? w.slice(1) : w;
}

export function recognise(command: string, output: string): Recorded[] {
  const out: Recorded[] = [];
  for (const seg of command.split(/&&|\|\||;|\n/)) {
    const w = words(seg).filter((x) => !x.startsWith("-c") || x.length > 2);
    const gi = w.findIndex((x) => x === "git" || x.endsWith("/git"));
    if (gi >= 0 && w[gi + 1] === "push" && (w.includes("-u") || w.includes("--set-upstream"))) {
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
