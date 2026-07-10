import type { UnifiedSession, UnifiedToolCall, UnifiedTurn } from "@harnesslab/core";

/**
 * Claude Code session JSONL -> UnifiedSession.
 *
 * Fault-tolerant by design: unknown line types are skipped and recorded in
 * parseWarnings, never thrown as an exception that blows up the whole parse
 * (the upstream format drifts across versions, so it's better to under-parse
 * than to silently produce a wrong result -- combined with golden-file tests,
 * a format change turns CI red instead of failing silently).
 *
 * Observed format details (Claude Code v2.1.x):
 * - Line types include user / assistant / attachment / queue-operation / ai-title /
 *   last-prompt / summary, etc. Only user and assistant participate in normalization.
 * - `isSidechain: true` marks a subagent's side trace and is skipped.
 * - A user line's message.content may be a plain string, or an array of text /
 *   tool_result blocks; tool_result links back to a tool_use block in a prior
 *   assistant line via tool_use_id.
 * - An assistant line's message.usage includes cache_read_input_tokens / cache_creation_input_tokens.
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
      warnings.push(`line ${i + 1} is not valid JSON, skipped`);
    }
  }

  const skippedTypes = new Map<string, number>();
  const turns: UnifiedTurn[] = [];
  /** tool_use_id -> the toolCall waiting to be filled in with its result */
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
      warnings.push(`a ${line.type} line is missing its message field, skipped`);
      continue;
    }

    const ts = line.timestamp ?? "";
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }

    if (line.type === "user") {
      const { text, toolResults } = splitUserContent(line.message.content);

      // Fill in the tool_result for its matching toolCall
      for (const tr of toolResults) {
        const call = tr.tool_use_id ? pendingToolCalls.get(tr.tool_use_id) : undefined;
        if (!call) {
          warnings.push(`tool_result ${tr.tool_use_id ?? "(no id)"} has no matching tool_use, discarded`);
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
      // assistant: multiple messages within the same turn (a tool loop) are merged
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
        // thinking / redacted_thinking blocks etc. don't carry over into the unified format
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
    warnings.push(`${pendingToolCalls.size} tool_use call(s) never received a tool_result (the session may have been interrupted)`);
  }
  for (const [t, n] of skippedTypes) {
    warnings.push(`skipped ${n} line(s) with type="${t}"`);
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
