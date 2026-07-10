/**
 * Unified Session Schema -- the common format every adapter normalizes into.
 * The assertion engine and reporting layer only ever see this format; they never
 * touch any upstream raw JSONL directly.
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
  /** Content the adapter skipped or downgraded while parsing, for diagnostics only; never used by assertions */
  parseWarnings?: string[];
}

export interface UnifiedTurn {
  index: number;
  role: "user" | "assistant";
  /**
   * Snapshot of the system prompt / tool schema, used for per-turn cache attribution diffing.
   * Stores a hash + length rather than the full text, to keep fixture files small.
   * Undefined when the upstream data doesn't expose it (e.g. Claude Code's interactive session
   * JSONL doesn't include the system prompt).
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

/** Extract the command string from every Bash-style tool call in a session (input to the forbidden_commands assertion) */
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

/** Sum token usage across an entire session */
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
