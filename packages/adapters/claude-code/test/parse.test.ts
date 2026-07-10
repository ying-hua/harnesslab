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

  it("parses session metadata correctly", () => {
    expect(session.schemaVersion).toBe("0.1");
    expect(session.source).toBe("claude-code");
    expect(session.sessionId).toBe("test-session-0001");
    expect(session.cwd).toBe("E:\\proj\\demo");
    expect(session.model).toBe("claude-fable-5");
    expect(session.startedAt).toBe("2026-07-01T10:00:01.000Z");
    expect(session.endedAt).toBe("2026-07-01T10:00:30.000Z");
  });

  it("merges a tool loop into a single assistant turn: user + assistant = 2 turns total", () => {
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].role).toBe("user");
    expect(session.turns[0].content).toContain("token expiry");
    expect(session.turns[1].role).toBe("assistant");
  });

  it("pairs tool_use with tool_result by id correctly", () => {
    const calls = session.turns[1].toolCalls;
    expect(calls).toHaveLength(2);

    expect(calls[0].name).toBe("Bash");
    expect(calls[0].input.command).toBe("pytest tests/test_auth.py");
    expect(calls[0].result.output).toContain("1 failed");
    expect(calls[0].result.isError).toBe(false);
    expect(calls[0].startedAt).toBe("2026-07-01T10:00:08.000Z");
    expect(calls[0].endedAt).toBe("2026-07-01T10:00:12.000Z");

    expect(calls[1].name).toBe("Edit");
    // Also extracts text when tool_result content is a block array
    expect(calls[1].result.output).toContain("has been updated");
  });

  it("sums usage per turn, including cache fields", () => {
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

  it("skips sidechain / isMeta / attachment / queue-operation / ai-title / last-prompt entirely", () => {
    const allText = JSON.stringify(session.turns);
    expect(allText).not.toContain("Subagent");
    expect(allText).not.toContain("meta line");
    // the sidechain's 999 tokens must not be counted
    expect(sumSessionTokens(session).output).toBeLessThan(999);
    const warnings = session.parseWarnings ?? [];
    expect(warnings.some((w) => w.includes("queue-operation"))).toBe(true);
    expect(warnings.some((w) => w.includes("ai-title"))).toBe(true);
  });

  it("finalResult takes the last assistant text", () => {
    expect(session.finalResult.text).toContain("clock-skew");
    expect(session.finalResult.isError).toBe(false);
    expect(session.finalResult.totalTokens).toEqual({
      input: 123,
      output: 112,
      cacheRead: 4550,
      cacheWrite: 200,
    });
  });

  it("extractBashCommands only picks up Bash calls", () => {
    expect(extractBashCommands(session)).toEqual(["pytest tests/test_auth.py"]);
  });
});

describe("parseSessionJsonl error tolerance", () => {
  it("skips a bad JSON line and records a warning instead of throwing", () => {
    const session = parseSessionJsonl('not json at all\n{"type":"user","isSidechain":false,"message":{"role":"user","content":"hi"},"timestamp":"2026-07-01T10:00:00.000Z","sessionId":"s1","cwd":"/x"}');
    expect(session.turns).toHaveLength(1);
    expect(session.parseWarnings?.some((w) => w.includes("not valid JSON"))).toBe(true);
  });

  it("returns an empty session for empty input", () => {
    const session = parseSessionJsonl("");
    expect(session.turns).toHaveLength(0);
    expect(session.sessionId).toBe("");
  });

  it("discards an orphaned tool_result and records a warning", () => {
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
