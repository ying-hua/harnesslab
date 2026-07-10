# AGENTS.md — development rules for agents working on this project

[English](AGENTS.md) | [中文](AGENTS.zh-CN.md)

This file only records **development rules** and **decisions made during implementation that the original design spec did not cover**.

## Common commands

```bash
npm install          # install workspaces
npm run build        # tsc -b, builds the three packages in project-reference order
npm test             # vitest (tests run against src directly, no build needed first)
```

## Package structure

- `packages/core` — `@harnesslab/core`: UnifiedSession / fixture / RunResult types + assertion engine. Depends on no adapter.
- `packages/adapters/claude-code` — `@harnesslab/adapter-claude-code`: parses `~/.claude/projects/**/*.jsonl`.
- `packages/cli` — `@harnesslab/cli`: the `freeze` / `run` / `report` commands; bin name `harnesslab`.

Cross-package imports always use the package name (`@harnesslab/core`), never relative paths. vitest resolves to `src` via alias; tsc builds via project references.

## Verified external facts (2026-07-09, from official docs at code.claude.com/docs)

- All details in spec §1.3 still hold (`--output-format json` includes `total_cost_usd` + per-model breakdown, 10MB stdin cap, `--allowedTools` prefix syntax `Bash(git diff *)`, session lookup scoped to project dir + git worktree).
- **New finding: `--bare` skips OAuth/keychain reads.** Auth must come from `ANTHROPIC_API_KEY` or an `apiKeyHelper` in `--settings`. This means Pro/Max subscription users cannot run `run` with `--bare` directly.
- npm package names `harnesslab`, `rerun`, `fixt`, `harness-replay` were all unclaimed as of 2026-07-09.

## Implementation decisions (not covered by the spec; may be changed with good reason)

1. **`run` does not add `--bare` by default**: because `--bare` skips OAuth, subscription users would fail auth outright. Rule: add `--bare` by default when `ANTHROPIC_API_KEY` is present (good reproducibility); otherwise omit it and warn "this run inherited the local harness config and is not a clean control group." The CLI offers `--bare` / `--no-bare` to override explicitly.
2. **Deriving the project-dir name from `cwd`**: replace every non-alphanumeric character with `-` (measured: `E:\MyProgram\harnesslab` → `E--MyProgram-harnesslab`).
3. **Adapter line-filtering rule**: only consume lines with `type: "user" | "assistant"` where `isSidechain !== true` and `isMeta !== true`; skip `attachment` / `queue-operation` / `ai-title` / `last-prompt` / `summary` and any unknown type (unknown types are counted into `parseWarnings`, never thrown — when upstream drifts, prefer under-parsing over crashing).
4. **UnifiedTurn merge semantics**: one assistant turn = all assistant messages between a user message and the next user message (tool loop merged); text is concatenated, toolCalls accumulated, usage summed. tool_result is back-filled onto its toolCall via `tool_use_id`.
5. **`forbidden_commands` match semantics**: each pattern does a **non-anchored glob match** against every Bash command in the session (`*` = `.*`, other chars escaped), i.e. "git push" matches "cd x && git push origin". Prefer false positives over false negatives.
6. **`files_changed` implementation**: at run time, first commit the frozen patch inside the worktree (with inline user.name/email), then after the run `git status --porcelain` gives the files the agent changed, matched against globs with picomatch (paths normalized to posix separators).
7. **No zod**: fixture validation uses a hand-written validator to keep heavyweight deps out. Dependency list: core → `yaml` + `picomatch`; cli → `commander` + `picocolors`.
8. **freeze v0.1 does not use an LLM for the assertion draft** (that is a week-3 task); it uses deterministic heuristics: infer `files_changed.must_include` from Edit/Write tool calls, infer `budget` from original usage ×2, and summarize `allowed_tools` `Bash(xxx *)` entries by the first token of each Bash command.
9. **Handling personal data in tests**: the golden file is a hand-authored, de-identified JSONL (structurally 1:1 with the real format); real sessions are never committed to the repo.
10. **Known gap (accepted for v0.1, addressed in v0.2)**: `extractBashCommands` / `forbidden_commands` only scan `Bash` tool calls; desktop/Windows sessions may run commands via a `PowerShell` tool (confirmed on a real local session), and those commands are currently not checked by forbidden_commands. Fix direction: maintain a set of shell-like tool names (Bash, PowerShell) in core and extract `input.command`.
11. **Run results on disk**: `.harnesslab/runs/<ISO-timestamp>__<caseId>__<configId>__<runIndex>.json`; `report` reads from here. `.harnesslab/` is gitignored.

## Development rules

- Upstream session parsing must be fault-tolerant: ignore unknown fields, skip unknown line types (counting a warning), and never throw an uncaught exception because of format drift.
- Every inferred/probabilistic conclusion exposed to users (cache attribution, etc.) must carry the `inferred` label — see the honesty boundary in spec §6.2.
- Test on Windows first (the product owner is on win32); handle paths with explicit conversion, never assume posix.
