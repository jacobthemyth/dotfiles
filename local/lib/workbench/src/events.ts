export type Event =
  | { kind: "sessionStarted"; harness: string; session: string; cwd: string; resumed: boolean }
  | { kind: "sessionEnded"; harness: string; session: string }
  | { kind: "beforeWrite"; harness: string; session: string; cwd: string; path: string; tool: string }
  | { kind: "beforeCommand"; harness: string; session: string; cwd: string; command: string; toolUseId?: string }
  | { kind: "afterCommand"; harness: string; session: string; cwd: string; command: string; output: string; toolUseId?: string }
  | { kind: "promptSubmitted"; harness: string; session: string; cwd: string }
  | { kind: "turnEnded"; harness: string; session: string };
export type Outcome = { deny?: string; context?: string };
