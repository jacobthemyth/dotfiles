export function sessionKeyFromEnv(flags: { session?: string }): string | null {
  if (process.env.WORKBENCH_SESSION) return process.env.WORKBENCH_SESSION;
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude-${process.env.CLAUDE_CODE_SESSION_ID}`;
  return flags.session ?? null;
}
