import picomatch from "picomatch";
import { spawnSync } from "node:child_process";
import type { Assertion, BudgetAssertion, FilesChangedAssertion } from "./fixture.js";
import type { AssertionResult } from "./run-result.js";

/** Context required to run assertions, collected by the runner and passed in */
export interface AssertionContext {
  /** The restored workspace directory (command assertions execute here) */
  workspaceDir: string;
  /** Files changed by the agent (relative to workspaceDir, posix separators) */
  changedFiles: string[];
  /** All Bash commands from the replayed session trace */
  bashCommands: string[];
  stats: {
    totalTokens: number;
    turns: number;
    costUsd?: number;
  };
  /** Injectable command executor (defaults to child_process), swappable in tests */
  execCommand?: ExecCommand;
}

export type ExecCommand = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => { exitCode: number; output: string };

const defaultExec: ExecCommand = (command, cwd, timeoutMs) => {
  const r = spawnSync(command, {
    shell: true,
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
  });
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { exitCode: 124, output: `[timeout after ${timeoutMs}ms]\n${output}` };
  }
  return { exitCode: r.status ?? 1, output };
};

/** Compile a forbidden_commands wildcard pattern into an unanchored regex (`*` = `.*`, everything else escaped) */
export function compileCommandPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

const toPosix = (p: string) => p.replace(/\\/g, "/");

export function runAssertion(assertion: Assertion, ctx: AssertionContext): AssertionResult {
  switch (assertion.type) {
    case "files_changed":
      return runFilesChanged(assertion, ctx);
    case "command_succeeds":
    case "command_fails": {
      const exec = ctx.execCommand ?? defaultExec;
      const timeoutMs = (assertion.timeout_s ?? 300) * 1000;
      const { exitCode, output } = exec(assertion.command, ctx.workspaceDir, timeoutMs);
      const wantSuccess = assertion.type === "command_succeeds";
      const passed = wantSuccess ? exitCode === 0 : exitCode !== 0;
      return {
        type: assertion.type,
        passed,
        detail: passed
          ? `\`${assertion.command}\` exited with ${exitCode}`
          : `\`${assertion.command}\` exited with ${exitCode} (expected ${wantSuccess ? "0" : "non-zero"})\n${truncate(output, 2000)}`,
      };
    }
    case "forbidden_commands": {
      const violations: string[] = [];
      for (const pattern of assertion.patterns) {
        const re = compileCommandPattern(pattern);
        for (const cmd of ctx.bashCommands) {
          if (re.test(cmd)) violations.push(`pattern "${pattern}" matched command: ${truncate(cmd, 200)}`);
        }
      }
      return {
        type: "forbidden_commands",
        passed: violations.length === 0,
        detail: violations.length === 0 ? `checked ${ctx.bashCommands.length} Bash command(s), no matches` : violations.join("\n"),
      };
    }
    case "budget":
      return runBudget(assertion, ctx);
    case "judge":
      return {
        type: "judge",
        passed: true,
        optional: true,
        detail: "the judge assertion is not implemented yet in v0.1; skipped (does not count toward pass/fail)",
      };
  }
}

function runFilesChanged(a: FilesChangedAssertion, ctx: AssertionContext): AssertionResult {
  const changed = ctx.changedFiles.map(toPosix);
  const problems: string[] = [];

  for (const glob of a.must_include ?? []) {
    const isMatch = picomatch(toPosix(glob));
    if (!changed.some((f) => isMatch(f))) {
      problems.push(`must_include "${glob}" did not match any changed file`);
    }
  }
  for (const glob of a.must_not_touch ?? []) {
    const isMatch = picomatch(toPosix(glob));
    const hits = changed.filter((f) => isMatch(f));
    for (const hit of hits) problems.push(`must_not_touch "${glob}" was violated: ${hit}`);
  }

  return {
    type: "files_changed",
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `changed files: ${changed.length > 0 ? changed.join(", ") : "(none)"}`
        : `${problems.join("\n")}\nactual changes: ${changed.length > 0 ? changed.join(", ") : "(none)"}`,
  };
}

function runBudget(a: BudgetAssertion, ctx: AssertionContext): AssertionResult {
  const problems: string[] = [];
  const facts: string[] = [];

  if (a.max_total_tokens !== undefined) {
    facts.push(`tokens ${ctx.stats.totalTokens}/${a.max_total_tokens}`);
    if (ctx.stats.totalTokens > a.max_total_tokens) problems.push(`total tokens ${ctx.stats.totalTokens} exceeded the limit of ${a.max_total_tokens}`);
  }
  if (a.max_turns !== undefined) {
    facts.push(`turns ${ctx.stats.turns}/${a.max_turns}`);
    if (ctx.stats.turns > a.max_turns) problems.push(`turn count ${ctx.stats.turns} exceeded the limit of ${a.max_turns}`);
  }
  if (a.max_cost_usd !== undefined) {
    if (ctx.stats.costUsd === undefined) {
      facts.push(`cost unavailable (subscription auth doesn't expose a dollar figure); max_cost_usd skipped`);
    } else {
      facts.push(`cost $${ctx.stats.costUsd.toFixed(4)}/$${a.max_cost_usd}`);
      if (ctx.stats.costUsd > a.max_cost_usd) problems.push(`cost $${ctx.stats.costUsd.toFixed(4)} exceeded the limit of $${a.max_cost_usd}`);
    }
  }

  return {
    type: "budget",
    passed: problems.length === 0,
    detail: problems.length === 0 ? facts.join("; ") : problems.join("\n"),
  };
}

/** Run every assertion for a fixture; overall passed = every non-optional assertion passed */
export function runAssertions(assertions: Assertion[], ctx: AssertionContext): {
  passed: boolean;
  results: AssertionResult[];
} {
  const results = assertions.map((a) => runAssertion(a, ctx));
  const passed = results.every((r) => r.passed || r.optional);
  return { passed, results };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated, ${s.length} characters total]` : s;
}
