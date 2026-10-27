import type { Comment } from "./comments";
import type { ReviewFile } from "./submit";

const lines = (c: Comment) => (c.line.start === c.line.end ? `${c.line.start}` : `${c.line.start}-${c.line.end}`);

export type Lookup = (id: string) => { reviewId: string; comment: Comment } | null;

// A resolved thread is one line: it needs nothing from the agent, so its replies are left out.
const resolvedLine = (c: Comment) =>
  `- ~~resolved~~ **${c.type}** \`${c.path}:${lines(c)}\` (id \`${c.id}\`) — ${c.text} — closed${c.resolved!.text ? `: ${c.resolved!.text}` : ""}`;

export function renderMarkdown(r: ReviewFile, lookup: Lookup = () => null): string {
  const out: string[] = [`# Review ${r.id} for workset "${r.workset}"`, "", `Submitted ${r.submitted}`];
  if (r.message) out.push("", r.message);
  const members = new Map<string, Comment[]>();
  for (const c of r.comments) {
    const head = `### ${c.slug ?? c.repo}#${c.branch} @ ${c.sha.slice(0, 7)}`;
    members.set(head, [...(members.get(head) ?? []), c]);
  }
  if (r.comments.length === 0) out.push("", "No comments.");
  for (const [head, cs] of members) {
    out.push("", head);
    const paths = [...new Set(cs.map((c) => c.path))];
    for (const p of paths) {
      out.push("", `#### ${p}`);
      for (const c of cs.filter((x) => x.path === p)) {
        if (c.resolved) { out.push(resolvedLine(c)); continue; }
        out.push(`- **${c.type}** \`${c.path}:${lines(c)}\` (id \`${c.id}\`) — ${c.text}`);
        for (const rep of c.replies) out.push(`  - reply by ${rep.by} at ${rep.at}: ${rep.text}`);
      }
    }
  }
  if (r.edits.length) {
    out.push("", "## Your edits were committed", "");
    for (const e of r.edits) out.push(`- ${e.repo} ${e.branch} \`${e.sha.slice(0, 7)}\` — ${e.files.join(", ")}`);
  }
  if (r.failed.length) {
    out.push("", "## Failed edits", "");
    for (const f of r.failed) out.push(`- ${f.repo} ${f.branch} — ${f.files.join(", ")}: ${f.error}`);
  }
  const resolved = r.resolved ?? []; // review files from before resolution have no list
  if (resolved.length) {
    out.push("", "## Resolved", "", "The reviewer closed these threads; they need no reply and no work.", "");
    for (const id of resolved) {
      const hit = lookup(id);
      out.push(hit ? `- \`${id}\` (review ${hit.reviewId}) \`${hit.comment.path}:${lines(hit.comment)}\` — ${hit.comment.text}` : `- \`${id}\` (not found)`);
    }
  }
  return out.join("\n") + "\n";
}
