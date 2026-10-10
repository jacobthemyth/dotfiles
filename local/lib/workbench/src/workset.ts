import { join } from "node:path";
import { sub } from "./paths";
import { readJson, writeJson, listJson, now, removeFile } from "./store";

export type Role = "work" | "throwaway";
export type Pr = { number: number; url: string; draft: boolean; state: string };
export type Member = {
  id: string; repo: string; slug: string | null; branch: string; worktree: string | null;
  base: string | null; pr: Pr | null; order: number | null; role: Role; added_by: string; added_at: string;
};
export type Workset = { name: string; created: string; members: Member[]; sessions: string[]; ignored: string[] };

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const dir = () => sub("worksets");
const file = (name: string) => join(dir(), `${name}.json`);

export function memberId(m: { slug: string | null; repo: string; branch: string }) { return `${m.slug ?? m.repo}#${m.branch}`; }
export function listWorksets(): string[] { return listJson(dir()); }
export function loadWorkset(name: string): Workset | null { return readJson<Workset>(file(name)); }
export function saveWorkset(ws: Workset): void { writeJson(file(ws.name), ws); }
export function deleteWorkset(name: string): void { removeFile(file(name)); }
export function createWorkset(name: string, by: string): Workset {
  if (!NAME.test(name)) throw new Error(`workbench: invalid workset name "${name}"`);
  if (loadWorkset(name)) throw new Error(`workbench: workset "${name}" exists`);
  const ws: Workset = { name, created: now(), members: [], sessions: by.startsWith("hand") ? [] : [by], ignored: [] };
  saveWorkset(ws);
  return ws;
}
export type MemberInput = Partial<Omit<Member, "id" | "added_at">> & Pick<Member, "repo" | "branch" | "added_by">;
export function addMember(ws: Workset, input: MemberInput): Member {
  const slug = input.slug ?? null;
  const id = memberId({ slug, repo: input.repo, branch: input.branch });
  const existing = ws.members.find((m) => m.id === id);
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null)));
    return existing;
  }
  const m: Member = {
    id, repo: input.repo, slug, branch: input.branch, worktree: input.worktree ?? null, base: input.base ?? null,
    pr: input.pr ?? null, order: input.order ?? null, role: input.role ?? "work", added_by: input.added_by, added_at: now(),
  };
  ws.members.push(m);
  return m;
}
export function removeMember(ws: Workset, id: string): void { ws.members = ws.members.filter((m) => m.id !== id); }
