# AGENTS.md — 写这个项目的 agent 开发规则

[English](AGENTS.md) | [中文](AGENTS.zh-CN.md)

本文件只记录**开发规则**和**规格书没有覆盖、由实现过程中自主决定的决策**。

## 常用命令

```bash
npm install          # workspaces 安装
npm run build        # tsc -b，按 project references 顺序构建三个包
npm test             # vitest（测试直接跑 src，不需要先 build）
```

## 包结构

- `packages/core` — `@harnesslab/core`：UnifiedSession/fixture/RunResult 类型 + 断言引擎。不依赖任何 adapter。
- `packages/adapters/claude-code` — `@harnesslab/adapter-claude-code`：解析 `~/.claude/projects/**/*.jsonl`。
- `packages/cli` — `@harnesslab/cli`：`freeze`/`run`/`report` 命令，bin 名 `harnesslab`。

跨包 import 一律用包名（`@harnesslab/core`），不用相对路径。vitest 通过 alias 直接解析到 src；tsc 通过 project references 构建。

## 已核实的外部事实（2026-07-09，来自官方文档 code.claude.com/docs）

- 规格书 §1.3 的全部细节仍然成立（`--output-format json` 含 `total_cost_usd` + 按模型明细、stdin 10MB 上限、`--allowedTools` 前缀语法 `Bash(git diff *)`、session 查找限定项目目录+git worktree）。
- **新发现：`--bare` 跳过 OAuth/keychain 读取**，认证只能来自 `ANTHROPIC_API_KEY` 或 `--settings` 里的 `apiKeyHelper`。这意味着 Pro/Max 订阅用户不能直接用 `--bare` 跑 `run`。
- npm 包名 `harnesslab`、`rerun`、`fixt`、`harness-replay` 截至 2026-07-09 均未被占用。

## 实现决策记录（规格书未覆盖，可在有充分理由时修改）

1. **`run` 默认不加 `--bare`**：因为 `--bare` 跳过 OAuth，订阅用户会直接认证失败。规则：检测到 `ANTHROPIC_API_KEY` 时默认加 `--bare`（可复现性好），否则不加并在输出里 warn "本次 run 继承了本机 harness 配置，结果不是干净对照组"。CLI 提供 `--bare` / `--no-bare` 显式覆盖。
2. **session JSONL 项目目录名的推导**：`cwd` 中所有非字母数字字符替换为 `-`（实测 `E:\MyProgram\harnesslab` → `E--MyProgram-harnesslab`）。
3. **adapter 的行过滤规则**：只消费 `type: "user" | "assistant"` 且 `isSidechain !== true` 且 `isMeta !== true` 的行；`attachment`/`queue-operation`/`ai-title`/`last-prompt`/`summary` 及未知类型全部跳过（未知类型计数进 `parseWarnings`，不报错——上游格式漂移时宁可少解析也不崩）。
4. **UnifiedTurn 的合并语义**：一个 assistant turn = 从一条用户消息到下一条用户消息之间的全部 assistant 消息（工具循环合并），text 拼接、toolCalls 累加、usage 求和。tool_result 通过 `tool_use_id` 回填到对应 toolCall。
5. **断言里 `forbidden_commands` 的匹配语义**：pattern 对 session 里每条 Bash 命令做**非锚定的通配匹配**（`*` = `.*`，其余字符转义），即 "git push" 能匹配 "cd x && git push origin"。宁可误报不可漏报。
6. **`files_changed` 的实现**：run 时在 worktree 里先把 frozen patch commit 掉（inline 配置 user.name/email），跑完后 `git status --porcelain` 得到 agent 改动的文件列表，用 picomatch 匹配 glob（路径统一转 posix 分隔符）。
7. **不引入 zod**：fixture 校验用手写 validator，保持零重量级依赖。依赖清单：core → `yaml` + `picomatch`；cli → `commander` + `picocolors`。
8. **freeze v0.1 的断言初稿不用 LLM**（那是第 3 周任务），用确定性启发式：从 session 的 Edit/Write 工具调用推 `files_changed.must_include`，从原始 usage ×2 推 `budget`，Bash 命令按首 token 归纳 `allowed_tools` 的 `Bash(xxx *)` 条目。
9. **测试对个人数据的处理**：golden file 是手工构造的脱敏 JSONL（结构 1:1 对齐真实格式），不把真实 session 提交进 repo。
10. **已知缺口（v0.1 接受，v0.2 处理）**：`extractBashCommands`/`forbidden_commands` 只扫 `Bash` 工具调用；桌面版/Windows 会话可能用 `PowerShell` 工具执行命令（本机真实 session 实测如此），这些命令目前不会被 forbidden_commands 检查。修复方向：core 里维护一个 shell 类工具名集合（Bash、PowerShell），提取 `input.command`。
11. **run 结果落盘**：`.harnesslab/runs/<ISO时间戳>__<caseId>__<configId>__<runIndex>.json`，`report` 从这里读。`.harnesslab/` 在 .gitignore 里。

## 开发规则

- 上游 session 格式解析必须容错：未知字段忽略、未知行类型跳过并计 warning，绝不因为格式漂移抛未捕获异常。
- 所有对外声明的推断性结论（缓存归因等）必须带 `inferred` 标注，见规格书 §6.2 的诚实边界。
- Windows 优先测试（产品负责人是 win32 环境），路径处理一律显式转换，不假设 posix。
