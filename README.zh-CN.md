# HarnessLab

> **pytest for your agent harness** —— 把真实的 AI coding agent 会话冻结成可重复运行的回归测试。

[English](README.md) | **中文**

**状态：v0.1 开发中，尚未发布。**

---

Agent = Model + Harness。你给 Claude Code 加了一个 skill、改了一段 `CLAUDE.md`、换了记忆扩展——到底有没有变*好*？目前唯一的办法是手动跑一遍任务、肉眼对比结果。

HarnessLab 把一次真实 session 冻结成 **fixture**，改配置后重跑多次，用统计口径而不是感觉来回答这个问题。

```bash
npx harnesslab freeze --last                  # 把刚结束的 Claude Code session 冻结成测试用例
npx harnesslab run cases/fix-auth -n 5        # 同一用例跑 5 次，看方差
npx harnesslab run cases/fix-auth --matrix configs/   # baseline vs 加了新 skill vs 删了 CLAUDE.md 某段
npx harnesslab report                         # 成功率 + token 中位数 ± σ
```

## 为什么做这个

harness engineering 圈子有个共识：*每当 agent 犯错，就工程化一个方案让它永不再犯。* 但"永不再犯"目前完全没有可验证的机制——全靠手工重跑、肉眼对比。HarnessLab 就是这个循环里缺失的**回归测试**环节。

市面上没有人做"录制真实 session → 冻结成 fixture → 改配置 → 重跑 → 量化对比"这个完整闭环。相邻的工具要么审计已经发生的会话（agenttrace），要么评测你自己插桩的 agent（agent-strace）；HarnessLab 把一个真实的 coding session 当作可复用的测试夹具。

## 设计原则

- **性质断言而非逐字节匹配**：`files_changed` / `command_succeeds` / `forbidden_commands` / `budget`，用来对抗 LLM 的非确定性。
- **不承诺单次可复现**，承诺的是"多次采样后的统计性质可比较"（`-n` + 方差报告）。
- **git worktree 隔离**：重放不污染你的工作区。
- **诚实边界**：任何拿不到 wire-level 请求数据的推断（如缓存归因），一律标注 `inferred`。

## 命令

| 命令 | 做什么 |
|---|---|
| `freeze` | 定位一个 Claude Code session（`~/.claude/projects/**/*.jsonl`），提取任务 + git 状态，写出 fixture 目录。v0.1 用确定性启发式生成断言初稿，LLM 辅助生成在 v0.2。 |
| `run` | 在临时 `git worktree` 里还原冻结时的工作区，跑 `claude -p --output-format json`，执行 fixture 的断言，然后清理。`-n` 多次采样，`--matrix` 跨配置对比。 |
| `report` | 把 `.harnesslab/runs/*.json` 汇总成表格（成功率、token 中位数 ± σ）。`--json` 供 CI 消费。 |

### Fixture 格式

`freeze` 产出一个目录：

```
cases/fix-auth-token-expiry/
  case.yaml                    # 任务、workspace ref、工具白名单、断言
  workspace.patch              # 冻结时的未提交改动
  original-session.jsonl.gz    # 原始 session 存档（供回溯，不参与重放）
```

```yaml
# case.yaml
schemaVersion: "0.1"
source: claude-code
task: "修复 auth.py 里的 token 过期 bug"
workspace:
  base_ref: a1b2c3
  dirty_patch: workspace.patch
allowed_tools: [Read, Edit, "Bash(pytest *)"]
assertions:
  - type: files_changed
    must_include: [src/auth.py]
    must_not_touch: ["migrations/**"]
  - type: command_succeeds
    command: pytest tests/test_auth.py
  - type: forbidden_commands
    patterns: ["git push", "rm -rf"]
  - type: budget
    max_total_tokens: 80000
    max_turns: 25
```

## 关于 `--bare` 与认证

`claude --bare` 跳过 hooks、skills、plugins、MCP servers、`CLAUDE.md` 的自动发现，这让它成为做"干净对照组"的天然机制。**但 `--bare` 也跳过 OAuth/keychain**，只能通过 `ANTHROPIC_API_KEY`（或 `--settings` 里的 `apiKeyHelper`）认证。

因此 `run` 会自动决策：设置了 `ANTHROPIC_API_KEY` 时默认加 `--bare`（可复现的干净对照）；否则不加 `--bare` 并警告"本次 run 继承了本机 harness 配置，**不是**干净对照组"。可用 `--bare` / `--no-bare` 显式覆盖。

## 开发

```bash
npm install
npm test        # vitest（35 个测试）
npm run build   # tsc -b
```

包结构：

- `packages/core` —— `@harnesslab/core`：统一 session schema、fixture 格式、断言引擎。
- `packages/adapters/claude-code` —— `@harnesslab/adapter-claude-code`：把 `~/.claude/projects/**/*.jsonl` 解析成统一 schema。
- `packages/cli` —— `@harnesslab/cli`：`freeze` / `run` / `report` 命令。

adapter 是关键的架构边界：每种 session 格式写一个 adapter 归一到内部 schema，这样上游格式漂移只影响一个 adapter，不会波及断言层和报告层。开发规则与决策记录见 [AGENTS.md](AGENTS.md)。

## 路线图

- **v0.1** —— Claude Code adapter + `freeze`/`run`/`report` 闭环 *（当前）*
- **v0.2** —— LLM 辅助断言生成、缓存归因分析（inferred）、HTML 报告、GitHub Action
- **v0.3+** —— Pi / Codex adapter

## 许可证

[MIT](LICENSE)
