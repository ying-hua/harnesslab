import { spawn } from "node:child_process";
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
  bare?: boolean; // commander: --bare / --no-bare; undefined = auto
  keepWorktree?: boolean;
  cwd?: string;
}

/** A set of variables injected into the claude -p invocation (control group / experiment group) */
interface RunConfig {
  id: string;
  bare?: boolean;
  /** Flags appended verbatim to the claude command, e.g. ["--append-system-prompt-file", "skills/x.md"] */
  flags?: string[];
}

/** The response body of claude -p --output-format json (parsed defensively; fields may change across versions) */
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

export async function runCase(casePath: string, opts: RunOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const { fixture, fixtureDir, caseId } = loadFixture(casePath, cwd);
  const repoRoot = tryGit(["rev-parse", "--show-toplevel"], cwd)?.trim();
  if (!repoRoot) {
    console.error(pc.red(`${cwd} is not a git repository; run needs a git worktree to isolate the workspace`));
    process.exitCode = 1;
    return;
  }

  const configs = resolveConfigs(opts, cwd);
  const n = Math.max(1, parseInt(opts.n ?? "1", 10) || 1);
  const allResults: RunResult[] = [];

  for (const config of configs) {
    console.log(pc.bold(`\n▶ case=${caseId} config=${config.id} × ${n} run(s)`));
    for (let i = 0; i < n; i++) {
      const result = await runOnce({ fixture, fixtureDir, caseId, repoRoot, config, runIndex: i, opts });
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
    if (files.length === 0) throw new Error(`no .json configs found under matrix directory ${dir}`);
    return files.map((f) => loadConfig(path.join(dir, f)));
  }
  if (opts.config) return [loadConfig(path.resolve(cwd, opts.config))];
  return [{ id: "baseline" }];
}

function loadConfig(file: string): RunConfig {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunConfig>;
  return { id: raw.id ?? path.basename(file, ".json"), bare: raw.bare, flags: raw.flags };
}

async function runOnce(args: {
  fixture: FixtureCase;
  fixtureDir: string;
  caseId: string;
  repoRoot: string;
  config: RunConfig;
  runIndex: number;
  opts: RunOptions;
}): Promise<RunResult> {
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
    // 1. Restore the workspace as it was when frozen
    git(["worktree", "add", "--detach", worktreeDir, fixture.workspace.base_ref], repoRoot);
    try {
      if (fixture.workspace.dirty_patch) {
        git(["apply", path.resolve(fixtureDir, fixture.workspace.dirty_patch)], worktreeDir);
      }
      // Commit the frozen state so that everything `git status` sees afterwards is the agent's own changes
      git(["add", "-A"], worktreeDir);
      git(
        ["-c", "user.name=harnesslab", "-c", "user.email=harnesslab@localhost", "commit", "--allow-empty", "-m", "harnesslab: frozen workspace state"],
        worktreeDir,
      );

      // 2. Invoke claude non-interactively
      const { claudeResult, rawOutput, exitCode } = await invokeClaude(
        fixture,
        config,
        worktreeDir,
        opts,
        `${caseId} / ${config.id} #${runIndex + 1}`,
      );
      if (!claudeResult) {
        return {
          ...base,
          passed: false,
          assertionResults: [],
          durationMs: Date.now() - t0,
          runnerError: `claude -p failed (exit code ${exitCode}): ${rawOutput.slice(0, 500)}`,
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

      // 3. Locate the session trace produced by the replay (needed for forbidden_commands)
      let bashCommands: string[] = [];
      let traceWarning: string | undefined;
      if (claudeResult.session_id) {
        const traceFile = findSessionFile({ cwd: worktreeDir, sessionId: claudeResult.session_id });
        if (traceFile) {
          bashCommands = extractBashCommands(parseSessionFile(traceFile.filePath));
        } else {
          traceWarning = `could not find the trace file for replay session ${claudeResult.session_id}; forbidden_commands is evaluated against an empty command list`;
        }
      }

      // 4. Run assertions
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
        ...(claudeResult.is_error ? { runnerError: "claude returned is_error=true" } : {}),
      };
    } finally {
      if (opts.keepWorktree) {
        console.log(pc.dim(`  worktree kept at ${worktreeDir}`));
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

/** Mutable live-progress state, updated as stream-json events arrive, read by the spinner. */
interface LiveProgress {
  turn: number;
  outputTokens: number; // cumulative output tokens across assistant turns — the number that visibly climbs
  lastAction: string;
}

function invokeClaude(
  fixture: FixtureCase,
  config: RunConfig,
  worktreeDir: string,
  opts: RunOptions,
  progressLabel: string,
): Promise<{ claudeResult?: ClaudeJsonResult; rawOutput: string; exitCode: number }> {
  // --bare decision: explicit > config > auto (only dare to use --bare when an API key is present, since --bare skips OAuth)
  const bare = opts.bare ?? config.bare ?? Boolean(process.env.ANTHROPIC_API_KEY);
  if (!bare) {
    console.log(pc.yellow("  ⚠ not using --bare (no ANTHROPIC_API_KEY; --bare would skip subscription auth). This run inherited the local harness config and is not a clean control group."));
  }

  // stream-json emits one JSON event per line (JSONL) as the run progresses, so we can show live
  // turn / token / current-action progress instead of blocking on a single blob at the end.
  // `-p` + `--output-format stream-json` requires `--verbose` (Claude Code errors otherwise).
  const cliArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    ...(bare ? ["--bare"] : []),
    ...(fixture.allowed_tools.length > 0 ? ["--allowedTools", fixture.allowed_tools.join(",")] : []),
    ...(config.flags ?? []),
  ];

  // The task text is piped via stdin to avoid cross-platform argv quoting hell (cmd.exe escaping rules differ from sh's).
  return new Promise((resolve) => {
    const child = spawn(quoteForShell("claude", cliArgs), {
      shell: true,
      cwd: worktreeDir,
      windowsHide: true,
      timeout: 30 * 60 * 1000,
    });

    const live: LiveProgress = { turn: 0, outputTokens: 0, lastAction: "starting" };
    let stdout = "";
    let stderr = "";
    let buf = ""; // holds the partial trailing line between data chunks
    let resultEvent: ClaudeJsonResult | undefined;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const ev = tryParseJson(trimmed);
      if (!ev) return;
      if (ev.type === "assistant") {
        live.turn += 1;
        const msg = (ev as { message?: AssistantMessage }).message;
        if (typeof msg?.usage?.output_tokens === "number") live.outputTokens += msg.usage.output_tokens;
        const action = describeAssistantAction(msg);
        if (action) live.lastAction = action;
      } else if (ev.type === "result") {
        // The final result event carries the same fields the old --output-format json blob did.
        resultEvent = ev as ClaudeJsonResult;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        consumeLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d: string) => (stderr += d));
    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits before consuming stdin
    child.stdin.end(fixture.task);

    const stopSpinner = startSpinner(progressLabel, live);

    child.on("error", (err) => {
      stopSpinner(live);
      resolve({ rawOutput: err instanceof Error ? err.message : String(err), exitCode: 1 });
    });
    child.on("close", (code) => {
      if (buf.trim()) consumeLine(buf); // flush any line not terminated by a newline
      stopSpinner(live);
      const rawOutput = [stdout, stderr].filter(Boolean).join("\n");
      if (resultEvent) {
        return resolve({ claudeResult: resultEvent, rawOutput, exitCode: 0 });
      }
      resolve({ rawOutput: rawOutput || `claude produced no result event (exit code ${code ?? 1})`, exitCode: code ?? 1 });
    });
  });
}

/** A raw assistant message from stream-json (the Anthropic API message shape; parsed defensively). */
interface AssistantMessage {
  content?: Array<{ type?: string; name?: string; text?: string; input?: Record<string, unknown> }>;
  usage?: { output_tokens?: number };
}

function tryParseJson(line: string): { type?: string } | undefined {
  try {
    return JSON.parse(line) as { type?: string };
  } catch {
    return undefined;
  }
}

/** Summarize what the assistant did this turn for the live line, e.g. "Edit auth.py" or "Bash: pytest ...". */
function describeAssistantAction(msg?: AssistantMessage): string | undefined {
  const blocks = msg?.content ?? [];
  let text: string | undefined;
  for (const b of blocks) {
    if (b.type === "tool_use") {
      const input = b.input ?? {};
      const file = input.file_path ?? input.path ?? input.notebook_path;
      if (typeof file === "string") return `${b.name} ${file.split(/[\\/]/).pop()}`;
      if (b.name === "Bash" && typeof input.command === "string") return `Bash: ${input.command.replace(/\s+/g, " ").slice(0, 40)}`;
      return b.name ?? "tool";
    }
    if (b.type === "text" && b.text?.trim()) text = "writing…";
  }
  return text;
}

/**
 * Show a live progress line while claude executes: spinner + elapsed + turn + cumulative output tokens + current action.
 * On a TTY, redraw in place with \r; off a TTY (CI / redirected output), print a heartbeat line every 20s so logs
 * don't get spammed. Returns a stop function (called on close/error) that clears the timer and prints a final summary.
 */
function startSpinner(label: string, live: LiveProgress): (final: LiveProgress) => void {
  const t0 = Date.now();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const isTty = Boolean(process.stdout.isTTY);
  let i = 0;
  const elapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
  };
  const status = () => {
    const turn = live.turn > 0 ? ` · turn ${live.turn}` : "";
    const tok = ` · ↓${fmtTokens(live.outputTokens)} tok`;
    return `${elapsed(Date.now() - t0)} — ${label}${turn}${tok} · ${live.lastAction}`;
  };
  const tick = () => {
    if (isTty) {
      const width = Math.max(20, (process.stdout.columns ?? 80) - 4);
      let content = `running ${status()}`;
      if (content.length > width) content = content.slice(0, width - 1) + "…";
      process.stdout.write(`\r  ${pc.cyan(frames[i++ % frames.length])} ${content.padEnd(width)}`);
    } else {
      console.log(pc.dim(`  … running ${status()}`));
    }
  };
  tick();
  const timer = setInterval(tick, isTty ? 100 : 20000);
  timer.unref?.();
  return (final: LiveProgress) => {
    clearInterval(timer);
    if (isTty) {
      const width = process.stdout.columns ? process.stdout.columns - 1 : 79;
      process.stdout.write("\r" + " ".repeat(width) + "\r");
    }
    console.log(pc.dim(`  ✓ done in ${elapsed(Date.now() - t0)} · ${final.turn} turns · ↓${fmtTokens(final.outputTokens)} output tokens`));
  };
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Assemble a command string for shell:true: quote args containing spaces/special chars and escape inner double quotes */
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
  console.log(pc.bold("\nsummary"));
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
      `  ${configId}: passed ${rs.filter((r) => r.passed).length}/${rs.length} (${(passRate * 100).toFixed(0)}%), ` +
        `tokens median ${median(tokenTotals).toLocaleString()} ± ${Math.round(stddev(tokenTotals)).toLocaleString()}`,
    );
  }
  if (n === 1) console.log(pc.dim("  tip: a single run is heavily affected by LLM variance; use -n 5 to sample and see the statistical spread"));
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
