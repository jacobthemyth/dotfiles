import * as hunk from "./hunk";
import { syncMember } from "./notes";
import { config, hasWorktree, loadReview, startReview } from "./review";
import { loadWindow, repoint } from "./window";
import * as inbox from "./inbox";
import { listPointers } from "./session";
import { closeInPane, submitInPane } from "./sidebar-review";
import { buildRows, clamp, headerLine, KEYS, oneLine, move, scroll, splitKeys, STATUS, type Row } from "./sidebar-model";
import { diffBase } from "./stack";
import { loadWorkset, type Workset } from "./workset";


export async function runSidebar(name: string): Promise<number> {
  if (!process.stdin.isTTY) { console.error("workbench: the sidebar needs a terminal"); return 1; }
  const cfg = config();
  let showThrowaway = false, sel = 0, top = 0, status = "", rows: Row[] = [], done = false, busy = false;

  const workset = (): Workset => {
    const ws = loadWorkset(name);
    if (!ws) throw new Error(`workbench: no workset "${name}"`);
    return ws;
  };

  const draw = () => {
    const ws = workset();
    const review = loadReview(name);
    const sessions = listPointers().filter((p) => p.workset === name).map((pointer) => ({ pointer, reviews: inbox.list(pointer.key) }));
    rows = buildRows(ws, cfg, { showThrowaway, sessions, current: loadWindow(name)?.current ?? null });
    sel = clamp(rows, sel);
    const width = process.stdout.columns || 44;
    const fit = (s: string) => (s.length > width ? s.slice(0, width - 1) + "…" : s);
    const out = [`\x1b[1m${headerLine(name, review?.id ?? null)}\x1b[0m`, ""];
    const height = Math.max(1, (process.stdout.rows || 24) - 5);
    top = scroll(top, sel, height);
    rows.slice(top, top + height).forEach((r, j) => {
      const i = top + j, line = fit(r.text);
      out.push(i === sel ? `\x1b[7m${line}\x1b[0m` : r.kind === "header" ? `\x1b[1m${line}\x1b[0m` : line);
    });
    out.push("", fit(oneLine(status)), `\x1b[2m${fit(KEYS)}\x1b[0m`);
    process.stdout.write("\x1b[H\x1b[2J" + out.join("\r\n"));
  };
  // hunk holds the current member's notes only in memory: snapshot them every tick, so a deletion or a
  // `/resolve` there takes effect within seconds. Warnings (an unknown thread) become the status line.
  const sync = () => {
    if (done || busy) return;
    try {
      const w = loadWindow(name);
      if (!w?.hunkSessionId || !w.current || !hunk.hasSession(w.hunkSessionId)) return;
      const m = workset().members.find((x) => x.id === w.current);
      if (!m || !hasWorktree(m)) return;
      const r = syncMember(w, m);
      if (r.warnings.length) status = r.warnings[r.warnings.length - 1];
    } catch (e) { status = (e as Error).message; }
  };
  // Every paint goes through here: nothing after quit, and an error becomes the status line, not a crash.
  const render = () => {
    if (done || busy) return;
    try { draw(); } catch (e) { process.stdout.write(`\x1b[H\x1b[2J${(e as Error).message}\r\n`); }
  };

  const show = (r: Row) => {
    const w = loadWindow(name);
    if (!w) { status = `no window; run workbench open ${name}`; return; }
    const ws = workset();
    const [to, base] = r.kind === "stack" ? [r.node.top, r.node.bottomBase] : r.kind === "member" ? [r.member, diffBase(r.member, cfg)] : [null, ""];
    if (!to) return;
    if (!to.worktree) { status = `${to.id} has no worktree`; return; }
    status = repoint(w, ws, to, base) ? `showing ${base}...${to.branch}` : `hunk reload failed for ${to.id}`;
  };

  return await new Promise<number>((resolve) => {
    const timer = setInterval(() => { sync(); render(); }, 5000);
    const restore = () => { try { process.stdin.setRawMode(false); } catch {} };
    process.on("exit", restore);
    const quit = () => {
      done = true;
      clearInterval(timer);
      restore();
      process.stdin.pause();
      process.stdout.write("\x1b[H\x1b[2J");
      resolve(0);
    };
    // Submit and close take over the pane in line mode; keys reaching the sidebar meanwhile are dropped.
    const reviewAction = async (key: "s" | "c") => {
      busy = true;
      try {
        if (key === "c") await closeInPane(name);
        else await submitInPane(name);
      } catch (e) { status = (e as Error).message; }
      busy = false;
      if (done) return;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      render();
    };
    const onKey = (key: string) => {
      const row = rows[sel];
      switch (key) {
        case "q": case "\x03": return quit();
        case "j": case "\x1b[B": sel = move(rows, sel, 1); break;
        case "k": case "\x1b[A": sel = move(rows, sel, -1); break;
        case "\r": if (row) show(row); break;
        case "t": showThrowaway = !showThrowaway; break;
        case "r":
          if (loadReview(name)) { status = STATUS.alreadyOpen; break; }
          try { status = `review ${startReview(name, { allowDirty: false }).id} open`; } catch (e) { status = (e as Error).message; }
          break;
        case "s": case "c":
          if (!loadReview(name)) { status = key === "s" ? STATUS.nothingToSubmit : STATUS.nothingToClose; break; }
          void reviewAction(key); return;
        default: return;
      }
      render();
    };
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    let pending = "";
    process.stdin.on("data", (chunk: string) => {
      try {
        const { keys, rest } = splitKeys(pending + chunk);
        pending = rest;
        for (const key of keys) if (!done && !busy) onKey(key);
      } catch (e) { status = (e as Error).message; render(); }
    });
    render();
  });
}
