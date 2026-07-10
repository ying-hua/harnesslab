import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionJsonl } from "@harnesslab/adapter-claude-code";
import { extractBashCommands, sumSessionTokens } from "@harnesslab/core";

const goldenPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/golden-session.jsonl",
);
const golden = fs.readFileSync(goldenPath, "utf8");

describe("parseSessionJsonl (golden file)", () => {
  const session = parseSessionJsonl(golden);

  it("session 元信息正确", () => {
    expect(session.schemaVersion).toBe("0.1");
    expect(session.source).toBe("claude-code");
    expect(session.sessionId).toBe("test-session-0001");
    expect(session.cwd).toBe("E:\\proj\\demo");
    expect(session.model).toBe("claude-fable-5");
    expect(session.startedAt).toBe("2026-07-01T10:00:01.000Z");
    expect(session.endedAt).toBe("2026-07-01T10:00:30.000Z");
  });

  it("工具循环合并为一个 assistant turn：user + assistant 共 2 个 turn", () => {
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].role).toBe("user");
    expect(session.turns[0].content).toContain("token 过期");
    expect(session.turns[1].role).toBe("assistant");
  });

  it("tool_use 与 tool_result 通过 id 正确配对", () => {
    const calls = session.turns[1].toolCalls;
    expect(calls).toHaveLength(2);

    expect(calls[0].name).toBe("Bash");
    expect(calls[0].input.command).toBe("pytest tests/test_auth.py");
    expect(calls[0].result.output).toContain("1 failed");
    expect(calls[0].result.isError).toBe(false);
    expect(calls[0].startedAt).toBe("2026-07-01T10:00:08.000Z");
    expect(calls[0].endedAt).toBe("2026-07-01T10:00:12.000Z");

    expect(calls[1].name).toBe("Edit");
    // tool_result content 为块数组时也能取出文本
    expect(calls[1].result.output).toContain("has been updated");
  });

  it("usage 按 turn 求和，含 cache 字段", () => {
    expect(session.turns[1].usage).toEqual({
      inputTokens: 123,
      outputTokens: 112,
      cacheReadTokens: 4550,
      cacheCreationTokens: 200,
    });
    const totals = sumSessionTokens(session);
    expect(totals.input).toBe(123);
    expect(totals.output).toBe(112);
    expect(totals.cacheRead).toBe(4550);
    expect(totals.cacheWrite).toBe(200);
  });

  it("sidechain / isMeta / attachment / queue-operation / ai-title / last-prompt 全部被跳过", () => {
    const allText = JSON.stringify(session.turns);
    expect(allText).not.toContain("子代理");
    expect(allText).not.toContain("meta 行");
    // sidechain 的 999 token 不计入
    expect(sumSessionTokens(session).output).toBeLessThan(999);
    const warnings = session.parseWarnings ?? [];
    expect(warnings.some((w) => w.includes("queue-operation"))).toBe(true);
    expect(warnings.some((w) => w.includes("ai-title"))).toBe(true);
  });

  it("finalResult 取最后一条 assistant 文本", () => {
    expect(session.finalResult.text).toContain("时钟偏移");
    expect(session.finalResult.isError).toBe(false);
    expect(session.finalResult.totalTokens).toEqual({
      input: 123,
      output: 112,
      cacheRead: 4550,
      cacheWrite: 200,
    });
  });

  it("extractBashCommands 只取 Bash 调用", () => {
    expect(extractBashCommands(session)).toEqual(["pytest tests/test_auth.py"]);
  });
});

describe("parseSessionJsonl 容错", () => {
  it("坏 JSON 行跳过并计 warning，不抛异常", () => {
    const session = parseSessionJsonl('not json at all\n{"type":"user","isSidechain":false,"message":{"role":"user","content":"hi"},"timestamp":"2026-07-01T10:00:00.000Z","sessionId":"s1","cwd":"/x"}');
    expect(session.turns).toHaveLength(1);
    expect(session.parseWarnings?.some((w) => w.includes("不是合法 JSON"))).toBe(true);
  });

  it("空输入返回空 session", () => {
    const session = parseSessionJsonl("");
    expect(session.turns).toHaveLength(0);
    expect(session.sessionId).toBe("");
  });

  it("孤儿 tool_result 被丢弃并计 warning", () => {
    const line = JSON.stringify({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ tool_use_id: "toolu_orphan", type: "tool_result", content: "x" }] },
      timestamp: "2026-07-01T10:00:00.000Z",
      sessionId: "s1",
      cwd: "/x",
    });
    const session = parseSessionJsonl(line);
    expect(session.turns).toHaveLength(0);
    expect(session.parseWarnings?.some((w) => w.includes("toolu_orphan"))).toBe(true);
  });
});
