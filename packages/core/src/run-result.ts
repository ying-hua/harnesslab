/** A single execution result (spec §5.3), the input to `report` */

export interface AssertionResult {
  type: string;
  passed: boolean;
  /** Optional assertions (e.g. judge) don't count toward overall pass/fail */
  optional?: boolean;
  detail?: string;
}

export interface CacheBustEvent {
  atTurn: number;
  category:
    | "system_prompt_changed"
    | "tool_schema_changed"
    | "history_rewritten"
    | "unstable_content"
    | "unknown";
  detail: string;
  /** Always "inferred": we don't have access to the wire-level request, only what we can derive from session data */
  confidence: "inferred";
}

export interface RunResult {
  caseId: string;
  configId: string;
  runIndex: number;
  passed: boolean;
  assertionResults: AssertionResult[];
  costUsd?: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  turns: number;
  durationMs: number;
  startedAt: string;
  /** The new session id produced by this run, for later inspection */
  replaySessionId?: string;
  /** An error in the runner itself (not an assertion failure), e.g. the claude CLI is missing or the worktree failed */
  runnerError?: string;
  cacheAttribution?: CacheBustEvent[];
}
