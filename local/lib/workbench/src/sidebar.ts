import { foundId, type Found } from "./derive";
import { config, loadReview, repoint } from "./review";
import { listPointers } from "./session";
import { buildRows, clamp, move, scroll, type Row } from "./sidebar-model";
import { diffBase } from "./stack";
import { addMember, loadWorkset, saveWorkset, type Workset } from "./workset";

const CLI = new URL("./cli.ts", import.meta.url).pathname;
const KEYS = "j/k move  ⏎ show  a adopt  i ignore  r rescan  t throwaways  s submit  c close  q quit";

export async function runSidebar(name: string): Promise<number> {
  if (!process.stdin.isTTY) { console.error("workbench: the sidebar needs a terminal"); return 1; }
  const cfg = config();
  let unclaimed: Found[] | null = null;
  let showThrowaway = false, sel = 0, top = 0, status = "", rows: Row[] = [];

  const workset = (): Workset => {
    const ws = loadWorkset(name);
    if (!ws) throw new Error(`workbench: no workset "${name}"`);
    return ws;
  };

  const render = () => {
    const ws = workset();
    const review = loadReview(name);
    const sessions = listPointers().filter((p) => p.workset === name);
    rows = buildRows(ws, cfg, { showThrowaway, unclaimed, sessions, current: review?.current ?? null });
    sel = clamp(rows, sel);
    const width = process.stdout.columns || 44;
    const fit = (s: string) => (s.length > width ? s.slice(0, width - 1) + "…" : s);
    const out = [`\x1b[1m${name}\x1b[0m  ${review ? review.id : "(no open review)"}`, ""];
    const height = Math.max(1, (process.stdout.rows || 24) - 5);
    top = scroll(top, sel, height);
    rows.slice(top, top + height).forEach((r, j) => {
      const i = top + j, line = fit(r.text);
      out.push(i === sel ? `\x1b[7m${line}\x1b[0m` : r.kind === "header" ? `\x1b[1m${line}\x1b[0m` : line);
    });
    out.push("", fit(status), `\x1b[2m${fit(KEYS)}\x1b[0m`);
    process.stdout.write("\x1b[H\x1b[2J" + out.join("\r\n"));
  };

  // derive runs gh and git; do it in a child process so keys and paints are not held up.
  let scanning = false;
  const rescan = () => {
    if (scanning) return;
    scanning = true;
    const proc = Bun.spawn([process.execPath, CLI, "scan", "--json"], { stdout: "pipe", stderr: "ignore" });
    new Response(proc.stdout).text()
      .then((t) => { unclaimed = JSON.parse(t).unclaimed as Found[]; })
      .catch(() => { status = "rescan failed"; })
      .finally(() => { scanning = false; render(); });
  };

  const show = (r: Row) => {
    const review = loadReview(name);
    if (!review) { status = `no open review; run workbench open ${name}`; return; }
    const ws = workset();
    const [to, base] = r.kind === "stack" ? [r.node.top, r.node.bottomBase] : r.kind === "member" ? [r.member, diffBase(r.member, cfg)] : [null, ""];
    if (!to) return;
    if (!to.worktree) { status = `${to.id} has no worktree`; return; }
    status = repoint(review, ws, to, base) ? `showing ${base}...${to.branch}` : `hunk reload failed for ${to.id}`;
  };

  const claim = (r: Row, how: "adopt" | "ignore") => {
    if (r.kind !== "unclaimed") { status = `${how}: select an unclaimed item`; return; }
    const ws = workset(), f = r.found, id = foundId(f);
    if (how === "adopt") {
      addMember(ws, { repo: f.repo, slug: f.slug, branch: f.branch, worktree: f.worktree, pr: f.pr, base: f.base, base_source: f.base ? "pr" : undefined, added_by: "hand" });
    } else if (!ws.ignored.includes(id)) ws.ignored.push(id);
    saveWorkset(ws);
    unclaimed = unclaimed?.filter((x) => foundId(x) !== id) ?? null;
    status = `${how === "adopt" ? "adopted" : "ignored"} ${id}`;
  };

  return await new Promise<number>((resolve) => {
    const timer = setInterval(render, 5000);
    const quit = () => {
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[H\x1b[2J");
      resolve(0);
    };
    const onKey = (key: string) => {
      const row = rows[sel];
      switch (key) {
        case "q": case "\x03": return quit();
        case "j": case "\x1b[B": sel = move(rows, sel, 1); break;
        case "k": case "\x1b[A": sel = move(rows, sel, -1); break;
        case "\r": if (row) show(row); break;
        case "a": if (row) claim(row, "adopt"); break;
        case "i": if (row) claim(row, "ignore"); break;
        case "r": status = "rescanning…"; rescan(); break;
        case "t": showThrowaway = !showThrowaway; break;
        case "s": case "c": status = "submit/close arrive in a later task"; break;
        default: return;
      }
      render();
    };
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      try {
        for (const key of chunk.match(/\x1b\[[A-D]|[\s\S]/g) ?? []) onKey(key);
      } catch (e) { status = (e as Error).message; render(); }
    });
    render();
    rescan();
  });
}
