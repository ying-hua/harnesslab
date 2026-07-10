import picomatch from "picomatch";
import { spawnSync } from "node:child_process";
import type { Assertion, BudgetAssertion, FilesChangedAssertion } from "./fixture.js";
import type { AssertionResult } from "./run-result.js";

/** 断言执行所需的上下文，由 runner 收集后传入 */
export interface AssertionContext {
  /** 还原后的工作区目录（命令断言在这里执行） */
  workspaceDir: string;
  /** agent 改动的文件列表（相对 workspaceDir，posix 分隔符） */
  changedFiles: string[];
  /** 重放会话轨迹中的全部 Bash 命令 */
  bashCommands: string[];
  stats: {
    totalTokens: number;
    turns: number;
    costUsd?: number;
  };
  /** 可注入的命令执行器（默认走 child_process），供测试替换 */
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

/** 把 forbidden_commands 的通配模式编译成非锚定正则（`*` = `.*`，其余转义） */
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
          ? `\`${assertion.command}\` 退出码 ${exitCode}`
          : `\`${assertion.command}\` 退出码 ${exitCode}（期望${wantSuccess ? "为 0" : "非 0"}）\n${truncate(output, 2000)}`,
      };
    }
    case "forbidden_commands": {
      const violations: string[] = [];
      for (const pattern of assertion.patterns) {
        const re = compileCommandPattern(pattern);
        for (const cmd of ctx.bashCommands) {
          if (re.test(cmd)) violations.push(`模式 "${pattern}" 命中命令: ${truncate(cmd, 200)}`);
        }
      }
      return {
        type: "forbidden_commands",
        passed: violations.length === 0,
        detail: violations.length === 0 ? `检查了 ${ctx.bashCommands.length} 条 Bash 命令，无命中` : violations.join("\n"),
      };
    }
    case "budget":
      return runBudget(assertion, ctx);
    case "judge":
      return {
        type: "judge",
        passed: true,
        optional: true,
        detail: "judge 断言在 v0.1 尚未实现，已跳过（不计入 pass/fail）",
      };
  }
}

function runFilesChanged(a: FilesChangedAssertion, ctx: AssertionContext): AssertionResult {
  const changed = ctx.changedFiles.map(toPosix);
  const problems: string[] = [];

  for (const glob of a.must_include ?? []) {
    const isMatch = picomatch(toPosix(glob));
    if (!changed.some((f) => isMatch(f))) {
      problems.push(`must_include "${glob}" 没有匹配到任何被改动的文件`);
    }
  }
  for (const glob of a.must_not_touch ?? []) {
    const isMatch = picomatch(toPosix(glob));
    const hits = changed.filter((f) => isMatch(f));
    for (const hit of hits) problems.push(`must_not_touch "${glob}" 被违反: ${hit}`);
  }

  return {
    type: "files_changed",
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `改动文件: ${changed.length > 0 ? changed.join(", ") : "(无)"}`
        : `${problems.join("\n")}\n实际改动: ${changed.length > 0 ? changed.join(", ") : "(无)"}`,
  };
}

function runBudget(a: BudgetAssertion, ctx: AssertionContext): AssertionResult {
  const problems: string[] = [];
  const facts: string[] = [];

  if (a.max_total_tokens !== undefined) {
    facts.push(`tokens ${ctx.stats.totalTokens}/${a.max_total_tokens}`);
    if (ctx.stats.totalTokens > a.max_total_tokens) problems.push(`总 token ${ctx.stats.totalTokens} 超过上限 ${a.max_total_tokens}`);
  }
  if (a.max_turns !== undefined) {
    facts.push(`turns ${ctx.stats.turns}/${a.max_turns}`);
    if (ctx.stats.turns > a.max_turns) problems.push(`轮数 ${ctx.stats.turns} 超过上限 ${a.max_turns}`);
  }
  if (a.max_cost_usd !== undefined) {
    if (ctx.stats.costUsd === undefined) {
      facts.push(`cost 不可得（订阅认证拿不到美元口径），max_cost_usd 跳过`);
    } else {
      facts.push(`cost $${ctx.stats.costUsd.toFixed(4)}/$${a.max_cost_usd}`);
      if (ctx.stats.costUsd > a.max_cost_usd) problems.push(`成本 $${ctx.stats.costUsd.toFixed(4)} 超过上限 $${a.max_cost_usd}`);
    }
  }

  return {
    type: "budget",
    passed: problems.length === 0,
    detail: problems.length === 0 ? facts.join("; ") : problems.join("\n"),
  };
}

/** 跑一个 fixture 的全部断言；整体 passed = 所有非 optional 断言都 passed */
export function runAssertions(assertions: Assertion[], ctx: AssertionContext): {
  passed: boolean;
  results: AssertionResult[];
} {
  const results = assertions.map((a) => runAssertion(a, ctx));
  const passed = results.every((r) => r.passed || r.optional);
  return { passed, results };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[截断，共 ${s.length} 字符]` : s;
}
