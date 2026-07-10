import type { UnifiedSession, UnifiedToolCall, UnifiedTurn } from "@harnesslab/core";

/**
 * Claude Code session JSONL → UnifiedSession。
 *
 * 容错优先：未知行类型跳过并计入 parseWarnings，绝不抛异常炸掉整个解析
 * （上游格式随版本漂移，宁可少解析也不静默产出错误结果——配合 golden file
 * 测试，格式一变 CI 先红）。
 *
 * 实测格式要点（Claude Code v2.1.x）：
 * - 行类型有 user / assistant / attachment / queue-operation / ai-title /
 *   last-prompt / summary 等，只有 user 和 assistant 参与归一化。
 * - `isSidechain: true` 是子代理（subagent）的旁路轨迹，跳过。
 * - user 行的 message.content 可能是字符串，也可能是 text / tool_result 块数组；
 *   tool_result 通过 tool_use_id 关联到之前 assistant 行里的 tool_use 块。
 * - assistant 行的 message.usage 含 cache_read_input_tokens / cache_creation_input_tokens。
 */

interface RawLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | RawContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface RawContentBlock {
  type?: string;
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result block
  tool_use_id?: string;
  content?: string | { type?: string; text?: string }[];
  is_error?: boolean;
}

export function parseSessionJsonl(jsonlText: string): UnifiedSession {
  const warnings: string[] = [];
  const lines: RawLine[] = [];

  for (const [i, rawLine] of jsonlText.split("\n").entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RawLine);
    } catch {
      warnings.push(`第 ${i + 1} 行不是合法 JSON，已跳过`);
    }
  }

  const skippedTypes = new Map<string, number>();
  const turns: UnifiedTurn[] = [];
  /** tool_use_id → 等待回填结果的 toolCall */
  const pendingToolCalls = new Map<string, UnifiedToolCall>();

  let sessionId = "";
  let cwd = "";
  let model = "";
  let startedAt = "";
  let endedAt = "";
  let lastAssistantText = "";

  const currentTurn = (): UnifiedTurn | undefined => turns[turns.length - 1];

  for (const line of lines) {
    if (line.sessionId && !sessionId) sessionId = line.sessionId;
    if (line.cwd && !cwd) cwd = line.cwd;

    if (line.type !== "user" && line.type !== "assistant") {
      const t = line.type ?? "(missing)";
      skippedTypes.set(t, (skippedTypes.get(t) ?? 0) + 1);
      continue;
    }
    if (line.isSidechain === true || line.isMeta === true) continue;
    if (!line.message) {
      warnings.push(`一条 ${line.type} 行缺少 message 字段，已跳过`);
      continue;
    }

    const ts = line.timestamp ?? "";
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }

    if (line.type === "user") {
      const { text, toolResults } = splitUserContent(line.message.content);

      // 回填 tool_result 到对应的 toolCall
      for (const tr of toolResults) {
        const call = tr.tool_use_id ? pendingToolCalls.get(tr.tool_use_id) : undefined;
        if (!call) {
          warnings.push(`tool_result ${tr.tool_use_id ?? "(无 id)"} 找不到对应的 tool_use，已丢弃`);
          continue;
        }
        call.result = { output: blockContentToText(tr.content), isError: tr.is_error === true };
        call.endedAt = ts || call.startedAt;
        pendingToolCalls.delete(tr.tool_use_id!);
      }

      if (text.trim()) {
        turns.push({ index: turns.length, role: "user", content: text, toolCalls: [] });
      }
    } else {
      // assistant：同一 turn 内的多条消息（工具循环）合并
      let turn = currentTurn();
      if (!turn || turn.role !== "assistant") {
        turn = { index: turns.length, role: "assistant", content: "", toolCalls: [] };
        turns.push(turn);
      }
      if (line.message.model && !model) model = line.message.model;

      const blocks = Array.isArray(line.message.content)
        ? line.message.content
        : typeof line.message.content === "string"
          ? [{ type: "text", text: line.message.content }]
          : [];

      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          turn.content += (turn.content ? "\n\n" : "") + block.text;
          lastAssistantText = block.text;
        } else if (block.type === "tool_use" && block.name) {
          const call: UnifiedToolCall = {
            name: block.name,
            input: block.input ?? {},
            result: { output: "", isError: false },
            startedAt: ts,
            endedAt: ts,
          };
          turn.toolCalls.push(call);
          if (block.id) pendingToolCalls.set(block.id, call);
        }
        // thinking / redacted_thinking 等块不进入统一格式
      }

      const u = line.message.usage;
      if (u) {
        const prev = turn.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        turn.usage = {
          inputTokens: prev.inputTokens + (u.input_tokens ?? 0),
          outputTokens: prev.outputTokens + (u.output_tokens ?? 0),
          cacheReadTokens: (prev.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        };
      }
    }
  }

  if (pendingToolCalls.size > 0) {
    warnings.push(`${pendingToolCalls.size} 个 tool_use 没有等到 tool_result（会话可能被中断）`);
  }
  for (const [t, n] of skippedTypes) {
    warnings.push(`跳过 ${n} 条 type="${t}" 的行`);
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const turn of turns) {
    if (!turn.usage) continue;
    input += turn.usage.inputTokens;
    output += turn.usage.outputTokens;
    cacheRead += turn.usage.cacheReadTokens ?? 0;
    cacheWrite += turn.usage.cacheCreationTokens ?? 0;
  }

  return {
    schemaVersion: "0.1",
    source: "claude-code",
    sessionId,
    cwd,
    startedAt,
    endedAt,
    model,
    turns,
    finalResult: {
      text: lastAssistantText,
      isError: false,
      totalTokens: { input, output, cacheRead, cacheWrite },
    },
    parseWarnings: warnings.length > 0 ? warnings : undefined,
  };
}

function splitUserContent(content: RawLine["message"] extends undefined ? never : string | RawContentBlock[] | undefined): {
  text: string;
  toolResults: RawContentBlock[];
} {
  if (typeof content === "string") return { text: content, toolResults: [] };
  if (!Array.isArray(content)) return { text: "", toolResults: [] };
  const textParts: string[] = [];
  const toolResults: RawContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) textParts.push(block.text);
    else if (block.type === "tool_result") toolResults.push(block);
  }
  return { text: textParts.join("\n\n"), toolResults };
}

function blockContentToText(content: RawContentBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");
}
