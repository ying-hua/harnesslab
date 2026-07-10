import { describe, expect, it } from "vitest";
import {
  compileCommandPattern,
  parseFixtureCase,
  FixtureValidationError,
  runAssertions,
  type AssertionContext,
} from "@harnesslab/core";

const baseCtx: AssertionContext = {
  workspaceDir: "/tmp/fake",
  changedFiles: ["src/auth.py", "tests/test_auth.py"],
  bashCommands: ["pytest tests/test_auth.py", "git diff"],
  stats: { totalTokens: 50_000, turns: 12, costUsd: 0.2 },
  execCommand: () => ({ exitCode: 0, output: "" }),
};

describe("files_changed", () => {
  it("must_include 命中即通过", () => {
    const { passed } = runAssertions(
      [{ type: "files_changed", must_include: ["src/auth.py"] }],
      baseCtx,
    );
    expect(passed).toBe(true);
  });

  it("must_include 未命中则失败", () => {
    const { passed, results } = runAssertions(
      [{ type: "files_changed", must_include: ["src/billing.py"] }],
      baseCtx,
    );
    expect(passed).toBe(false);
    expect(results[0].detail).toContain("src/billing.py");
  });

  it("must_not_touch 命中则失败，glob 生效", () => {
    const { passed } = runAssertions(
      [{ type: "files_changed", must_not_touch: ["tests/**"] }],
      baseCtx,
    );
    expect(passed).toBe(false);
  });

  it("Windows 反斜杠路径被归一化后匹配", () => {
    const { passed } = runAssertions(
      [{ type: "files_changed", must_include: ["src/**/*.py"] }],
      { ...baseCtx, changedFiles: ["src\\auth.py"] },
    );
    expect(passed).toBe(true);
  });
});

describe("command_succeeds / command_fails", () => {
  it("退出码 0 时 command_succeeds 通过、command_fails 失败", () => {
    const ctx = { ...baseCtx, execCommand: () => ({ exitCode: 0, output: "ok" }) };
    expect(runAssertions([{ type: "command_succeeds", command: "true" }], ctx).passed).toBe(true);
    expect(runAssertions([{ type: "command_fails", command: "true" }], ctx).passed).toBe(false);
  });

  it("失败时 detail 带命令输出", () => {
    const ctx = {
      ...baseCtx,
      execCommand: () => ({ exitCode: 2, output: "AssertionError: token not refreshed" }),
    };
    const { results } = runAssertions([{ type: "command_succeeds", command: "pytest" }], ctx);
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain("AssertionError");
  });
});

describe("forbidden_commands", () => {
  it("前缀出现在复合命令中也能命中（非锚定匹配）", () => {
    const { passed, results } = runAssertions(
      [{ type: "forbidden_commands", patterns: ["git push"] }],
      { ...baseCtx, bashCommands: ["cd repo && git push origin main"] },
    );
    expect(passed).toBe(false);
    expect(results[0].detail).toContain("git push");
  });

  it("通配符 * 展开为 .*", () => {
    const re = compileCommandPattern("curl *");
    expect(re.test("curl https://example.com")).toBe(true);
    expect(re.test("echo curl-less")).toBe(false);
  });

  it("正则特殊字符被转义", () => {
    const re = compileCommandPattern("rm -rf .");
    expect(re.test("rm -rf .")).toBe(true);
    expect(re.test("rm -rf x")).toBe(false);
  });

  it("无命中则通过", () => {
    const { passed } = runAssertions(
      [{ type: "forbidden_commands", patterns: ["git push", "rm -rf"] }],
      baseCtx,
    );
    expect(passed).toBe(true);
  });
});

describe("budget", () => {
  it("全部在预算内则通过", () => {
    const { passed } = runAssertions(
      [{ type: "budget", max_total_tokens: 80_000, max_turns: 25, max_cost_usd: 0.5 }],
      baseCtx,
    );
    expect(passed).toBe(true);
  });

  it("超 token 上限则失败", () => {
    const { passed } = runAssertions(
      [{ type: "budget", max_total_tokens: 10_000 }],
      baseCtx,
    );
    expect(passed).toBe(false);
  });

  it("订阅用户拿不到美元成本时 max_cost_usd 跳过而非失败", () => {
    const ctx = { ...baseCtx, stats: { ...baseCtx.stats, costUsd: undefined } };
    const { passed, results } = runAssertions([{ type: "budget", max_cost_usd: 0.01 }], ctx);
    expect(passed).toBe(true);
    expect(results[0].detail).toContain("跳过");
  });
});

describe("judge (v0.1 占位)", () => {
  it("标记 optional，不影响整体 pass", () => {
    const { passed, results } = runAssertions(
      [{ type: "judge", rubric: "处理了时钟偏移边界" }],
      baseCtx,
    );
    expect(passed).toBe(true);
    expect(results[0].optional).toBe(true);
  });
});

describe("fixture 解析与校验", () => {
  it("合法 case.yaml 解析成功", () => {
    const fixture = parseFixtureCase(`
schemaVersion: "0.1"
source: claude-code
task: 修复 auth.py 的 token 过期 bug
workspace:
  base_ref: a1b2c3
  dirty_patch: workspace.patch
allowed_tools: [Read, Edit, "Bash(pytest *)"]
assertions:
  - type: files_changed
    must_include: [src/auth.py]
  - type: budget
    max_total_tokens: 80000
`);
    expect(fixture.task).toContain("token");
    expect(fixture.assertions).toHaveLength(2);
  });

  it("非法 fixture 一次性报出全部问题", () => {
    expect(() =>
      parseFixtureCase(`
schemaVersion: "9.9"
source: ""
task: ""
workspace: {}
allowed_tools: not-an-array
assertions:
  - type: nonsense
  - type: command_succeeds
`),
    ).toThrowError(FixtureValidationError);
    try {
      parseFixtureCase(`
schemaVersion: "9.9"
source: ""
task: ""
workspace: {}
allowed_tools: not-an-array
assertions:
  - type: nonsense
  - type: command_succeeds
`);
    } catch (e) {
      const issues = (e as FixtureValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(6);
    }
  });
});
