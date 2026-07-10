/** 单次执行结果（规格书 §5.3），`report` 的输入 */

export interface AssertionResult {
  type: string;
  passed: boolean;
  /** optional 断言（如 judge）不计入整体 pass/fail */
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
  /** 永远是 "inferred"：我们拿不到 wire-level 请求，只能从 session 数据反推 */
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
  /** run 产生的新 session id，供回溯 */
  replaySessionId?: string;
  /** run 器本身出错（非断言失败），例如 claude CLI 不存在、worktree 失败 */
  runnerError?: string;
  cacheAttribution?: CacheBustEvent[];
}
