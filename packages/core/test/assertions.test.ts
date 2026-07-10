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
  it("passes when must_include matches", () => {
    const { passed } = runAssertions(
      [{ type: "files_changed", must_include: ["src/auth.py"] }],
      baseCtx,
    );
    expect(passed).toBe(true);
  });

  it("fails when must_include doesn't match", () => {
    const { passed, results } = runAssertions(
      [{ type: "files_changed", must_include: ["src/billing.py"] }],
      baseCtx,
    );
    expect(passed).toBe(false);
    expect(results[0].detail).toContain("src/billing.py");
  });

  it("fails when must_not_touch matches, glob works", () => {
    const { passed } = runAssertions(
      [{ type: "files_changed", must_not_touch: ["tests/**"] }],
      baseCtx,
    );
    expect(passed).toBe(false);
  });

  it("normalizes Windows backslash paths before matching", () => {
    const { passed } = runAssertions(
      [{ type: "files_changed", must_include: ["src/**/*.py"] }],
      { ...baseCtx, changedFiles: ["src\\auth.py"] },
    );
    expect(passed).toBe(true);
  });
});

describe("command_succeeds / command_fails", () => {
  it("passes command_succeeds and fails command_fails on exit code 0", () => {
    const ctx = { ...baseCtx, execCommand: () => ({ exitCode: 0, output: "ok" }) };
    expect(runAssertions([{ type: "command_succeeds", command: "true" }], ctx).passed).toBe(true);
    expect(runAssertions([{ type: "command_fails", command: "true" }], ctx).passed).toBe(false);
  });

  it("includes command output in the detail on failure", () => {
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
  it("matches a prefix embedded in a compound command (unanchored match)", () => {
    const { passed, results } = runAssertions(
      [{ type: "forbidden_commands", patterns: ["git push"] }],
      { ...baseCtx, bashCommands: ["cd repo && git push origin main"] },
    );
    expect(passed).toBe(false);
    expect(results[0].detail).toContain("git push");
  });

  it("expands the * wildcard to .*", () => {
    const re = compileCommandPattern("curl *");
    expect(re.test("curl https://example.com")).toBe(true);
    expect(re.test("echo curl-less")).toBe(false);
  });

  it("escapes regex special characters", () => {
    const re = compileCommandPattern("rm -rf .");
    expect(re.test("rm -rf .")).toBe(true);
    expect(re.test("rm -rf x")).toBe(false);
  });

  it("passes when there are no matches", () => {
    const { passed } = runAssertions(
      [{ type: "forbidden_commands", patterns: ["git push", "rm -rf"] }],
      baseCtx,
    );
    expect(passed).toBe(true);
  });
});

describe("budget", () => {
  it("passes when everything is within budget", () => {
    const { passed } = runAssertions(
      [{ type: "budget", max_total_tokens: 80_000, max_turns: 25, max_cost_usd: 0.5 }],
      baseCtx,
    );
    expect(passed).toBe(true);
  });

  it("fails when the token limit is exceeded", () => {
    const { passed } = runAssertions(
      [{ type: "budget", max_total_tokens: 10_000 }],
      baseCtx,
    );
    expect(passed).toBe(false);
  });

  it("skips max_cost_usd instead of failing when subscription auth has no dollar cost", () => {
    const ctx = { ...baseCtx, stats: { ...baseCtx.stats, costUsd: undefined } };
    const { passed, results } = runAssertions([{ type: "budget", max_cost_usd: 0.01 }], ctx);
    expect(passed).toBe(true);
    expect(results[0].detail).toContain("skipped");
  });
});

describe("judge (v0.1 placeholder)", () => {
  it("is marked optional and doesn't affect overall pass", () => {
    const { passed, results } = runAssertions(
      [{ type: "judge", rubric: "handles the clock-skew edge case" }],
      baseCtx,
    );
    expect(passed).toBe(true);
    expect(results[0].optional).toBe(true);
  });
});

describe("fixture parsing and validation", () => {
  it("parses a valid case.yaml successfully", () => {
    const fixture = parseFixtureCase(`
schemaVersion: "0.1"
source: claude-code
task: fix the token expiry bug in auth.py
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

  it("reports every issue at once for an invalid fixture", () => {
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
