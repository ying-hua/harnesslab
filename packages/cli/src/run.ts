import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import {
  extractBashCommands,
  parseFixtureCase,
  runAssertions,
  type FixtureCase,
  type RunResult,
} from "@harnesslab/core";
import { findSessionFile, parseSessionFile } from "@harnesslab/adapter-claude-code";
import { git, parsePorcelainStatus, tryGit } from "./git.js";

export interface RunOptions {
  n?: string;
  config?: string;
  matrix?: string;
  bare?: boolean; // commander: --bare / --no-bare；undefined = 自动
  keepWorktree?: boolean;
  cwd?: string;
}

/** 注入到 claude -p 调用的一组变量（对照组/实验组） */
interface RunConfig {
  id: string;
  bare?: boolean;
  /** 原样追加到 claude 命令的 flag，例如 ["--append-system-prompt-file", "skills/x.md"] */
  flags?: string[];
}

/** claude -p --output-format json 的返回体（防御性解析，字段可能随版本变化） */
interface ClaudeJsonResult {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function runCase(casePath: string, opts: RunOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const { fixture, fixtureDir, caseId } = loadFixture(casePath, cwd);
  const repoRoot = tryGit(["rev-parse", "--show-toplevel"], cwd)?.trim();
  if (!repoRoot) {
    console.error(pc.red(`${cwd} 不是 git 仓库，run 需要 git worktree 来隔离工作区`));
    process.exitCode = 1;
    return;
  }

  const configs = resolveConfigs(opts, cwd);
  const n = Math.max(1, parseInt(opts.n ?? "1", 10) || 1);
  const allResults: RunResult[] = [];

  for (const config of configs) {
    console.log(pc.bold(`\n▶ case=${caseId} config=${config.id} × ${n} 次`));
    for (let i = 0; i < n; i++) {
      const result = runOnce({ fixture, fixtureDir, caseId, repoRoot, config, runIndex: i, opts });
      allResults.push(result);
      persistResult(result, repoRoot);
      printRunResult(result, i);
    }
  }

  printAggregate(allResults, n);
  if (allResults.some((r) => !r.passed)) process.exitCode = 1;
}

function loadFixture(casePath: string, cwd: string): { fixture: FixtureCase; fixtureDir: string; caseId: string } {
  let p = path.resolve(cwd, casePath);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "case.yaml");
  const fixture = parseFixtureCase(fs.readFileSync(p, "utf8"));
  const fixtureDir = path.dirname(p);
  return { fixture, fixtureDir, caseId: path.basename(fixtureDir) };
}

function resolveConfigs(opts: RunOptions, cwd: string): RunConfig[] {
  if (opts.matrix) {
    const dir = path.resolve(cwd, opts.matrix);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (files.length === 0) throw new Error(`matrix 目录 ${dir} 下没有 .json 配置`);
    return files.map((f) => loadConfig(path.join(dir, f)));
  }
  if (opts.config) return [loadConfig(path.resolve(cwd, opts.config))];
  return [{ id: "baseline" }];
}

function loadConfig(file: string): RunConfig {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunConfig>;
  return { id: raw.id ?? path.basename(file, ".json"), bare: raw.bare, flags: raw.flags };
}

function runOnce(args: {
  fixture: FixtureCase;
  fixtureDir: string;
  caseId: string;
  repoRoot: string;
  config: RunConfig;
  runIndex: number;
  opts: RunOptions;
}): RunResult {
  const { fixture, fixtureDir, caseId, repoRoot, config, runIndex, opts } = args;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base: Omit<RunResult, "passed" | "assertionResults"> = {
    caseId,
    configId: config.id,
    runIndex,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    turns: 0,
    durationMs: 0,
    startedAt,
  };

  const worktreeDir = path.join(
    os.tmpdir(),
    `harnesslab-${caseId}-${config.id}-${runIndex}-${Date.now()}`.replace(/[^a-zA-Z0-9-]/g, "-"),
  );

  try {
    // 1. 还原冻结时的工作区
    git(["worktree", "add", "--detach", worktreeDir, fixture.workspace.base_ref], repoRoot);
    try {
      if (fixture.workspace.dirty_patch) {
        git(["apply", path.resolve(fixtureDir, fixture.workspace.dirty_patch)], worktreeDir);
      }
      // 把冻结状态 commit 掉，之后 git status 看到的就全是 agent 的改动
      git(["add", "-A"], worktreeDir);
      git(
        ["-c", "user.name=harnesslab", "-c", "user.email=harnesslab@localhost", "commit", "--allow-empty", "-m", "harnesslab: frozen workspace state"],
        worktreeDir,
      );

      // 2. 非交互执行 claude
      const { claudeResult, rawOutput, exitCode } = invokeClaude(fixture, config, worktreeDir, opts);
      if (!claudeResult) {
        return {
          ...base,
          passed: false,
          assertionResults: [],
          durationMs: Date.now() - t0,
          runnerError: `claude -p 执行失败（退出码 ${exitCode}）: ${rawOutput.slice(0, 500)}`,
        };
      }

      const usage = claudeResult.usage ?? {};
      const tokens = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
      };
      const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

      // 3. 找到重放产生的 session 轨迹（forbidden_commands 需要）
      let bashCommands: string[] = [];
      let traceWarning: string | undefined;
      if (claudeResult.session_id) {
        const traceFile = findSessionFile({ cwd: worktreeDir, sessionId: claudeResult.session_id });
        if (traceFile) {
          bashCommands = extractBashCommands(parseSessionFile(traceFile.filePath));
        } else {
          traceWarning = `找不到重放 session ${claudeResult.session_id} 的轨迹文件，forbidden_commands 断言基于空命令列表`;
        }
      }

      // 4. 断言
      const changedFiles = parsePorcelainStatus(git(["status", "--porcelain"], worktreeDir));
      const { passed, results } = runAssertions(fixture.assertions, {
        workspaceDir: worktreeDir,
        changedFiles,
        bashCommands,
        stats: {
          totalTokens,
          turns: claudeResult.num_turns ?? 0,
          costUsd: claudeResult.total_cost_usd,
        },
      });
      if (traceWarning) results.push({ type: "trace", passed: true, optional: true, detail: traceWarning });

      return {
        ...base,
        passed: passed && claudeResult.is_error !== true,
        assertionResults: results,
        costUsd: claudeResult.total_cost_usd,
        tokens,
        turns: claudeResult.num_turns ?? 0,
        durationMs: Date.now() - t0,
        replaySessionId: claudeResult.session_id,
        ...(claudeResult.is_error ? { runnerError: "claude 返回 is_error=true" } : {}),
      };
    } finally {
      if (opts.keepWorktree) {
        console.log(pc.dim(`  worktree 保留在 ${worktreeDir}`));
      } else {
        tryGit(["worktree", "remove", "--force", worktreeDir], repoRoot);
      }
    }
  } catch (e) {
    tryGit(["worktree", "remove", "--force", worktreeDir], repoRoot);
    return {
      ...base,
      passed: false,
      assertionResults: [],
      durationMs: Date.now() - t0,
      runnerError: e instanceof Error ? e.message : String(e),
    };
  }
}

function invokeClaude(
  fixture: FixtureCase,
  config: RunConfig,
  worktreeDir: string,
  opts: RunOptions,
): { claudeResult?: ClaudeJsonResult; rawOutput: string; exitCode: number } {
  // --bare 决策：显式 > 配置 > 自动（有 API key 才敢用 --bare，因为 --bare 跳过 OAuth）
  const bare = opts.bare ?? config.bare ?? Boolean(process.env.ANTHROPIC_API_KEY);
  if (!bare) {
    console.log(pc.yellow("  ⚠ 未使用 --bare（无 ANTHROPIC_API_KEY，--bare 会跳过订阅认证）。本次 run 继承了本机 harness 配置，不是干净对照组。"));
  }

  const cliArgs = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    ...(bare ? ["--bare"] : []),
    ...(fixture.allowed_tools.length > 0 ? ["--allowedTools", fixture.allowed_tools.join(",")] : []),
    ...(config.flags ?? []),
  ];

  // 任务文本走 stdin，避免跨平台 argv 引号地狱（cmd.exe 的转义规则和 sh 不同）
  const r = spawnSync(quoteForShell("claude", cliArgs), {
    shell: true,
    cwd: worktreeDir,
    input: fixture.task,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  const rawOutput = [r.stdout, r.stderr].filter(Boolean).join("\n");
  if (r.status !== 0 || !r.stdout) {
    return { rawOutput, exitCode: r.status ?? 1 };
  }
  try {
    return { claudeResult: JSON.parse(r.stdout) as ClaudeJsonResult, rawOutput, exitCode: 0 };
  } catch {
    return { rawOutput: `无法解析 claude 的 JSON 输出:\n${rawOutput}`, exitCode: r.status ?? 1 };
  }
}

/** 为 shell:true 拼一条命令：含空格/特殊字符的参数加双引号并转义内部双引号 */
export function quoteForShell(cmd: string, args: string[]): string {
  const quoted = args.map((a) => (/[\s"()*&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return [cmd, ...quoted].join(" ");
}

function persistResult(result: RunResult, repoRoot: string): void {
  const dir = path.join(repoRoot, ".harnesslab", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(dir, `${stamp}__${result.caseId}__${result.configId}__${result.runIndex}.json`),
    JSON.stringify(result, null, 2),
  );
}

function printRunResult(r: RunResult, i: number): void {
  const badge = r.passed ? pc.green("PASS") : pc.red("FAIL");
  const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(4)}` : "";
  const tokens = r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreation;
  console.log(`  [${i + 1}] ${badge} ${r.turns} turns, ${tokens.toLocaleString()} tokens${cost}, ${(r.durationMs / 1000).toFixed(1)}s`);
  if (r.runnerError) console.log(pc.red(`      runner error: ${r.runnerError}`));
  for (const a of r.assertionResults) {
    if (a.passed && !a.detail) continue;
    const mark = a.passed ? pc.dim("·") : pc.red("✗");
    const opt = a.optional ? pc.dim(" (optional)") : "";
    console.log(`      ${mark} ${a.type}${opt}: ${(a.detail ?? "").split("\n")[0]}`);
    if (!a.passed && a.detail && a.detail.includes("\n")) {
      for (const line of a.detail.split("\n").slice(1, 6)) console.log(pc.dim(`        ${line}`));
    }
  }
}

function printAggregate(results: RunResult[], n: number): void {
  if (results.length <= 1) return;
  console.log(pc.bold("\n汇总"));
  const byConfig = new Map<string, RunResult[]>();
  for (const r of results) {
    const list = byConfig.get(r.configId) ?? [];
    list.push(r);
    byConfig.set(r.configId, list);
  }
  for (const [configId, rs] of byConfig) {
    const passRate = rs.filter((r) => r.passed).length / rs.length;
    const tokenTotals = rs.map((r) => r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreation);
    console.log(
      `  ${configId}: 通过 ${rs.filter((r) => r.passed).length}/${rs.length} (${(passRate * 100).toFixed(0)}%), ` +
        `tokens 中位数 ${median(tokenTotals).toLocaleString()} ± ${Math.round(stddev(tokenTotals)).toLocaleString()}`,
    );
  }
  if (n === 1) console.log(pc.dim("  提示: 单次结果受 LLM 方差影响大，用 -n 5 采样看统计性质"));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stddev(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1));
}
