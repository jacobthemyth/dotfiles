import { parseArgs } from "node:util";
import { expandHome } from "../paths";
import { loadConfig, type Config } from "../config";
import { derive, foundId, prunable, unclaimed } from "../derive";
import * as gh from "../gh";
import { refreshStoredPr, summarizeAll, type WorksetSummary } from "../triage";
import { pruneWorktreeAndBranch } from "../git";
import { sessionKeyFromEnv } from "../session-key";
import { loadPointer, useWorkset } from "../session";
import { baseSource, diffBase, orderMembers } from "../stack";
import { addMember, createWorkset, listWorksets, loadWorkset, removeMember, saveWorkset, type Member, type Role, type Workset } from "../workset";

const USAGE = `usage: workbench workset <subcommand>
  list [--json]
  show <name>
  create <name>
  add <name> --repo <path> --branch <b> [--worktree <p>] [--base <ref>] [--order <n>] [--role work|throwaway]
  rm <name> <member-id>
  use <name> [--session <key>]
  adopt <name> <id> [--role work|throwaway]
  ignore <name> <id>
  prune <id> [--yes]`;

const fail = (msg: string, code = 1) => { console.error(msg); return code; };

function prCell(m: Member): string {
  return m.pr ? `#${m.pr.number} ${m.pr.state}${m.pr.draft ? " draft" : ""}` : "-";
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ")).join("\n");
}

function listTable(summaries: WorksetSummary[]): string {
  const rows = summaries.map((s) => [
    s.action, s.name, s.named ? "named" : "default", String(s.members.length),
    `${s.prMix.merged}m ${s.prMix.closed}c ${s.prMix.open}o ${s.prMix.nopr}n`, String(s.dirty),
    `${s.sessions.open} open / ${s.sessions.stale} stale / ${s.sessions.closed} closed`, s.sessions.last?.slice(0, 10) ?? "-",
  ]);
  return table([["action", "name", "kind", "members", "pr", "dirty", "sessions", "last"], ...rows]);
}

function show(ws: Workset): void {
  console.log(ws.name);
  if (ws.members.length === 0) { console.log("(no members)"); return; }
  let config: Config;
  try { config = loadConfig(); } catch { config = { default_branch: "main" } as Config; }
  const rows = orderMembers(ws.members).map((m) => [
    m.order === null ? "-" : String(m.order), m.role, `${m.slug ?? m.repo}#${m.branch}`, m.worktree ?? "-", prCell(m),
    diffBase(m, config), baseSource(m),
  ]);
  console.log(table([["order", "role", "member", "worktree", "pr", "base", "source"], ...rows]));
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "list": {
        const { values } = parseArgs({ args: rest, allowPositionals: false, options: { json: { type: "boolean" } } });
        const summaries = summarizeAll();
        if (gh.lastGhError) console.error("gh not available: PR state from stored members");
        for (const s of summaries) {
          const ws = loadWorkset(s.name);
          if (ws && refreshStoredPr(ws, s.members)) saveWorkset(ws);
        }
        const worksets = listWorksets().map(loadWorkset).filter((w): w is Workset => !!w);
        const counts: Record<string, number> = {};
        for (const f of unclaimed(derive(loadConfig()), worksets)) {
          const key = f.slug ?? f.repo;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        if (values.json) { console.log(JSON.stringify({ worksets: summaries, unclaimed: counts }, null, 2)); return 0; }
        console.log(listTable(summaries));
        const repos = Object.entries(counts);
        if (repos.length > 0) console.log(["", "unclaimed per repo:", ...repos.map(([k, n]) => `${k}  ${n}`)].join("\n"));
        return 0;
      }
      case "show": {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        if (positionals.length !== 1) return fail("usage: workbench workset show <name>", 2);
        const ws = loadWorkset(positionals[0]);
        if (!ws) return fail(`workbench: no workset "${positionals[0]}"`);
        show(ws);
        return 0;
      }
      case "create": {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        if (positionals.length !== 1) return fail("usage: workbench workset create <name>", 2);
        createWorkset(positionals[0], "hand");
        return 0;
      }
      case "add": {
        const { positionals, values } = parseArgs({
          args: rest, allowPositionals: true,
          options: { repo: { type: "string" }, branch: { type: "string" }, worktree: { type: "string" }, base: { type: "string" }, order: { type: "string" }, role: { type: "string" } },
        });
        if (positionals.length !== 1) return fail("usage: workbench workset add <name> --repo <path> --branch <b> [...]", 2);
        if (!values.repo || !values.branch) return fail("workbench: --repo and --branch are required");
        if (values.role !== undefined && values.role !== "work" && values.role !== "throwaway") return fail(`workbench: --role must be work or throwaway`);
        let order: number | undefined;
        if (values.order !== undefined) {
          order = Number(values.order);
          if (!Number.isInteger(order)) return fail("workbench: --order must be an integer");
        }
        const ws = loadWorkset(positionals[0]);
        if (!ws) return fail(`workbench: no workset "${positionals[0]}"`);
        const m = addMember(ws, {
          repo: expandHome(values.repo), branch: values.branch, added_by: "hand",
          worktree: values.worktree ? expandHome(values.worktree) : undefined,
          base: values.base, base_source: values.base ? "declared" : undefined, order, role: values.role as Role | undefined,
        });
        saveWorkset(ws);
        console.log(m.id);
        return 0;
      }
      case "rm": {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        if (positionals.length !== 2) return fail("usage: workbench workset rm <name> <member-id>", 2);
        const ws = loadWorkset(positionals[0]);
        if (!ws) return fail(`workbench: no workset "${positionals[0]}"`);
        if (!ws.members.some((m) => m.id === positionals[1])) return fail(`workbench: no member "${positionals[1]}" in "${ws.name}"`);
        removeMember(ws, positionals[1]);
        saveWorkset(ws);
        return 0;
      }
      case "use": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { session: { type: "string" } } });
        if (positionals.length !== 1) return fail("usage: workbench workset use <name> [--session <key>]", 2);
        const key = sessionKeyFromEnv(values);
        if (!key) return fail("workbench: no session key; set WORKBENCH_SESSION or pass --session <key>", 2);
        if (!loadPointer(key)) return fail(`workbench: no session ${key}`);
        const name = positionals[0];
        useWorkset(key, name);
        console.log(`${key} -> ${name}`);
        return 0;
      }
      case "adopt": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { role: { type: "string" } } });
        if (positionals.length !== 2) return fail("usage: workbench workset adopt <name> <id> [--role work|throwaway]", 2);
        if (values.role !== undefined && values.role !== "work" && values.role !== "throwaway") return fail(`workbench: --role must be work or throwaway`);
        const item = derive(loadConfig()).find((f) => foundId(f) === positionals[1]);
        if (!item) return fail(`workbench: nothing found with id "${positionals[1]}"`);
        const ws = loadWorkset(positionals[0]) ?? createWorkset(positionals[0], "hand");
        const m = addMember(ws, {
          repo: item.repo, slug: item.slug, branch: item.branch, worktree: item.worktree, pr: item.pr, base: item.base, base_source: item.base ? "pr" : undefined,
          role: values.role as Role | undefined, added_by: "hand",
        });
        saveWorkset(ws);
        console.log(m.id);
        return 0;
      }
      case "ignore": {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        if (positionals.length !== 2) return fail("usage: workbench workset ignore <name> <id>", 2);
        const ws = loadWorkset(positionals[0]);
        if (!ws) return fail(`workbench: no workset "${positionals[0]}"`);
        if (!ws.ignored.includes(positionals[1])) { ws.ignored.push(positionals[1]); saveWorkset(ws); }
        return 0;
      }
      case "prune": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { yes: { type: "boolean" } } });
        if (positionals.length !== 1) return fail("usage: workbench workset prune <id> [--yes]", 2);
        const id = positionals[0];
        const item = derive(loadConfig()).find((f) => foundId(f) === id);
        if (!item) return fail(`workbench: nothing found with id "${id}"`);
        const worksets = listWorksets().map(loadWorkset).filter((w): w is Workset => !!w);
        if (unclaimed([item], worksets).length === 0) return fail(`workbench: ${id} is claimed or ignored by a workset; not pruning`);
        const why = prunable([item])[0];
        if (!why) return fail(`workbench: ${id} is not prunable (${item.main ? "main worktree" : "no merged PR and upstream not gone"})`);
        const cmds = [
          ...(item.worktree ? [`git worktree remove ${item.worktree}`] : []),
          `git branch -D ${item.branch}`,
        ];
        if (!values.yes) {
          console.log(`would run in ${item.repo} (${why.reason}):`);
          for (const c of cmds) console.log(`  ${c}`);
          return 0;
        }
        if (!pruneWorktreeAndBranch(item.repo, item.worktree, item.branch)) return fail(`workbench: prune of ${id} failed`);
        console.log(`pruned ${id}`);
        return 0;
      }
      default:
        return fail(USAGE, 2);
    }
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(`workbench: ${(e as Error).message}`, 2);
    return fail((e as Error).message);
  }
}
