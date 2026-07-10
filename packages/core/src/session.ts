/**
 * 统一 Session Schema —— 所有 adapter 归一化之后的公共格式。
 * 断言引擎和报告层只认这个格式，不直接接触任何上游原始 JSONL。
 */

export interface UnifiedSession {
  schemaVersion: "0.1";
  source: "claude-code" | "pi" | "codex" | (string & {});
  sessionId: string;
  cwd: string;
  startedAt: string; // ISO8601
  endedAt: string;
  model: string;
  turns: UnifiedTurn[];
  finalResult: {
    text: string;
    isError: boolean;
    totalCostUsd?: number;
    totalTokens?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  /** adapter 解析过程中跳过/降级的内容，供诊断，不参与断言 */
  parseWarnings?: string[];
}

export interface UnifiedTurn {
  index: number;
  role: "user" | "assistant";
  /**
   * system prompt / tool schema 的快照，用于缓存归因逐轮 diff。
   * 不存全文，存 hash + 长度，避免 fixture 文件过大。
   * 上游数据拿不到时为 undefined（例如 Claude Code 交互式 session JSONL 不含 system prompt）。
   */
  requestPrefixSnapshot?: {
    systemPromptHash: string;
    systemPromptLength: number;
    toolSchemaHash: string;
  };
  content: string;
  toolCalls: UnifiedToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export interface UnifiedToolCall {
  name: string;
  input: Record<string, unknown>;
  result: { output: string; isError: boolean };
  startedAt: string;
  endedAt: string;
}

/** 从 session 中提取所有 Bash 类工具调用的命令字符串（forbidden_commands 断言的输入） */
export function extractBashCommands(session: UnifiedSession): string[] {
  const commands: string[] = [];
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (call.name === "Bash" && typeof call.input.command === "string") {
        commands.push(call.input.command);
      }
    }
  }
  return commands;
}

/** 汇总整个 session 的 token 用量 */
export function sumSessionTokens(session: UnifiedSession): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const turn of session.turns) {
    if (!turn.usage) continue;
    input += turn.usage.inputTokens;
    output += turn.usage.outputTokens;
    cacheRead += turn.usage.cacheReadTokens ?? 0;
    cacheWrite += turn.usage.cacheCreationTokens ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
