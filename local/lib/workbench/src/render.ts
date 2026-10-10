import type { Comment } from "./comments";
import type { ReviewFile } from "./submit";

const lines = (c: Comment) => (c.line.start === c.line.end ? `${c.line.start}` : `${c.line.start}-${c.line.end}`);

export function renderMarkdown(r: ReviewFile): string {
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
  return out.join("\n") + "\n";
}
