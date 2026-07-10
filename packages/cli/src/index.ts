#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { freeze } from "./freeze.js";
import { runCase } from "./run.js";
import { report } from "./report.js";

const program = new Command();

program
  .name("harnesslab")
  .description("Freeze a real AI coding agent session into a repeatable regression test -- pytest for your agent harness")
  .version("0.1.0");

program
  .command("freeze")
  .description("Freeze a Claude Code session into a test fixture")
  .option("--last", "Use the most recent session in the current project (default)")
  .option("--session <id>", "Use a specific session id")
  .option("-o, --output <dir>", "Fixture output directory (default cases/<task-slug>/)")
  .action((opts) => {
    void wrap(() => freeze(opts));
  });

program
  .command("run")
  .description("Replay a fixture in an isolated git worktree and run its assertions")
  .argument("<case>", "Path to case.yaml or the fixture directory")
  .option("-n <count>", "Number of samples (variance is reported when > 1)", "1")
  .option("--config <file>", "A single config JSON declaring flags to inject into claude -p")
  .option("--matrix <dir>", "Directory of configs; run and compare each config in turn")
  .option("--bare", "Force --bare (requires ANTHROPIC_API_KEY)")
  .option("--no-bare", "Force not using --bare")
  .option("--keep-worktree", "Keep the worktree after the run for inspection")
  .action((casePath, opts) => {
    // commander defaults --bare/--no-bare to true; only meaningful when the user passed it explicitly.
    // Check the raw argv to distinguish "not passed" (auto mode).
    const argv = process.argv;
    const bareExplicit = argv.includes("--bare") || argv.includes("--no-bare");
    void wrap(() => runCase(casePath, { ...opts, bare: bareExplicit ? opts.bare : undefined }));
  });

program
  .command("report")
  .description("Summarize results under .harnesslab/runs (pass rate / token variance)")
  .option("--json", "Output JSON for CI consumption")
  .action((opts) => {
    void wrap(() => report(opts));
  });

async function wrap(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(pc.red(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}

program.parse();
