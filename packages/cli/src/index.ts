#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { freeze } from "./freeze.js";
import { runCase } from "./run.js";
import { report } from "./report.js";

const program = new Command();

program
  .name("harnesslab")
  .description("把真实的 AI coding agent 会话冻结成可重复运行的回归测试 —— pytest for your agent harness")
  .version("0.1.0");

program
  .command("freeze")
  .description("把一个 Claude Code session 冻结成测试夹具（fixture）")
  .option("--last", "取当前项目最近一次 session（默认行为）")
  .option("--session <id>", "指定 session id")
  .option("-o, --output <dir>", "fixture 输出目录（默认 cases/<task-slug>/）")
  .action((opts) => {
    wrap(() => freeze(opts));
  });

program
  .command("run")
  .description("在隔离的 git worktree 里重放 fixture 并执行断言")
  .argument("<case>", "case.yaml 路径或 fixture 目录")
  .option("-n <count>", "采样次数（>1 时报告方差）", "1")
  .option("--config <file>", "单个配置 JSON（声明注入 claude -p 的 flag）")
  .option("--matrix <dir>", "配置目录，逐个配置对比运行")
  .option("--bare", "强制使用 --bare（需要 ANTHROPIC_API_KEY）")
  .option("--no-bare", "强制不使用 --bare")
  .option("--keep-worktree", "运行后保留 worktree 供排查")
  .action((casePath, opts) => {
    // commander 对 --bare/--no-bare 的默认值是 true，只有用户显式传了才有意义；
    // 通过检查原始 argv 区分"没传"（自动模式）
    const argv = process.argv;
    const bareExplicit = argv.includes("--bare") || argv.includes("--no-bare");
    wrap(() => runCase(casePath, { ...opts, bare: bareExplicit ? opts.bare : undefined }));
  });

program
  .command("report")
  .description("汇总 .harnesslab/runs 下的结果（成功率 / token 方差）")
  .option("--json", "输出 JSON 供 CI 消费")
  .action((opts) => {
    wrap(() => report(opts));
  });

function wrap(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(pc.red(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}

program.parse();
