import { parseArgs } from "node:util";
import { expandHome } from "../paths";
import { bindSession, loadPointer } from "../session";
import { addMember, createWorkset, listWorksets, loadWorkset, removeMember, saveWorkset, type Member, type Role, type Workset } from "../workset";

const USAGE = `usage: workbench workset <subcommand>
  list
  show <name>
  create <name>
  add <name> --repo <path> --branch <b> [--worktree <p>] [--base <ref>] [--order <n>] [--role work|throwaway]
  rm <name> <member-id>
  use <name> [--session <key>]`;

export function sessionKeyFromEnv(flags: { session?: string }): string | null {
  if (process.env.WORKBENCH_SESSION) return process.env.WORKBENCH_SESSION;
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude-${process.env.CLAUDE_CODE_SESSION_ID}`;
  return flags.session ?? null;
}

const fail = (msg: string, code = 1) => { console.error(msg); return code; };

function prCell(m: Member): string {
  return m.pr ? `#${m.pr.number} ${m.pr.state}${m.pr.draft ? " draft" : ""}` : "-";
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ")).join("\n");
}

function show(ws: Workset): void {
  console.log(ws.name);
  if (ws.members.length === 0) { console.log("(no members)"); return; }
  const rows = ws.members.map((m) => [
    m.order === null ? "-" : String(m.order), m.role, `${m.slug ?? m.repo}#${m.branch}`, m.worktree ?? "-", prCell(m),
  ]);
  console.log(table([["order", "role", "member", "worktree", "pr"], ...rows]));
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "list": {
        for (const n of listWorksets()) console.log(n);
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
          base: values.base, order, role: values.role as Role | undefined,
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
        const ws = loadWorkset(name) ?? createWorkset(name, key);
        if (!ws.sessions.includes(key)) { ws.sessions.push(key); saveWorkset(ws); }
        bindSession(key, name);
        console.log(`${key} -> ${name}`);
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
