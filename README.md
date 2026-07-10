# HarnessLab

> **pytest for your agent harness** — freeze real AI coding-agent sessions into repeatable regression tests.

**English** | [中文](README.zh-CN.md)

**Status: v0.1 in development, not yet published.**

---

Agent = Model + Harness. You added a skill, edited a line of `CLAUDE.md`, swapped a memory extension — did it actually get *better*? Right now there is no way to know except running the task by hand and eyeballing the result.

HarnessLab freezes one real session into a **fixture**, replays it many times after you change the config, and answers that question with statistics instead of vibes.

```bash
npx harnesslab freeze --last                  # freeze the Claude Code session you just finished into a test case
npx harnesslab run cases/fix-auth -n 5        # run the same case 5 times, measure variance
npx harnesslab run cases/fix-auth --matrix configs/   # baseline vs. "with new skill" vs. "CLAUDE.md section removed"
npx harnesslab report                         # pass rate + token median ± σ
```

## Why this exists

The harness-engineering community agrees on a mantra: *every time the agent makes a mistake, engineer a fix so it never happens again.* But "never again" has no verification mechanism today — it's all manual reruns and eyeballing. HarnessLab is the missing **regression-test** layer for that loop.

Nobody else does the full **record real session → freeze into fixture → change config → replay → quantify** loop. Neighboring tools audit sessions that already happened (agenttrace) or evaluate agents you instrumented yourself (agent-strace); HarnessLab treats a real coding session as a reusable test fixture.

## Design principles

- **Property assertions, not byte-for-byte matching.** `files_changed` / `command_succeeds` / `forbidden_commands` / `budget` — designed to withstand LLM non-determinism.
- **No promise of single-run reproducibility.** The promise is that *statistical properties across many samples* are comparable (`-n` + variance reporting).
- **git worktree isolation.** Replays never pollute your working tree.
- **Honest boundaries.** Any conclusion we infer without wire-level request data (e.g. cache attribution) is always labeled `inferred`.

## Commands

| Command | What it does |
|---|---|
| `freeze` | Locate a Claude Code session (`~/.claude/projects/**/*.jsonl`), extract the task + git state, and write a fixture directory. v0.1 drafts assertions with deterministic heuristics; LLM-assisted drafting lands in v0.2. |
| `run` | Restore the frozen workspace in a temporary `git worktree`, run `claude -p --output-format json`, execute the fixture's assertions, and clean up. `-n` samples multiple times; `--matrix` compares configs. |
| `report` | Aggregate `.harnesslab/runs/*.json` into a table (pass rate, token median ± σ). `--json` for CI. |

### The fixture format

`freeze` produces a directory:

```
cases/fix-auth-token-expiry/
  case.yaml                    # task, workspace ref, allowed tools, assertions
  workspace.patch              # uncommitted diff at freeze time
  original-session.jsonl.gz    # original session archive (for reference, not replayed)
```

```yaml
# case.yaml
schemaVersion: "0.1"
source: claude-code
task: "Fix the token-expiry bug in auth.py"
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

## A note on `--bare` and auth

`claude --bare` skips auto-discovery of hooks, skills, plugins, MCP servers, and `CLAUDE.md`, which makes it the natural mechanism for a clean control group. **But `--bare` also skips OAuth/keychain**, so it only authenticates via `ANTHROPIC_API_KEY` (or an `apiKeyHelper` in `--settings`).

`run` therefore decides automatically: with `ANTHROPIC_API_KEY` set it defaults to `--bare` (reproducible clean control); otherwise it runs without `--bare` and warns that the run inherited your local harness config and is **not** a clean control group. Override with `--bare` / `--no-bare`.

## Running it after cloning

Not yet on npm, so `npx harnesslab` won't fetch it — but one `npm install` in the clone makes the command available locally (a `prepare` hook builds every package for you):

```bash
git clone <repo> && cd harnesslab
npm install                         # installs deps and builds all packages
npx harnesslab run cases/fix-auth   # run from the repo root, no long node path
```

`npx` resolves `harnesslab` from the repo's local `node_modules/.bin`, so run it from anywhere inside the clone.

Prefer a bare `harnesslab` command that works from any directory? Link it onto your PATH once:

```bash
npm link -w @harnesslab/cli   # registers a global `harnesslab` shim
harnesslab run cases/fix-auth
```

> On Windows, `npm link` needs Developer Mode or an elevated shell to create the global symlink. If it fails, stick with `npx harnesslab` from inside the repo, or add `packages/cli/dist/index.js` to your own launcher.

## Development

```bash
npm install
npm test        # vitest (35 tests)
npm run build   # tsc -b
```

Packages:

- `packages/core` — `@harnesslab/core`: unified session schema, fixture format, assertion engine.
- `packages/adapters/claude-code` — `@harnesslab/adapter-claude-code`: parse `~/.claude/projects/**/*.jsonl` into the unified schema.
- `packages/cli` — `@harnesslab/cli`: the `freeze` / `run` / `report` commands.

The adapter is the key architectural boundary: every session format gets one adapter that normalizes to the internal schema, so upstream format drift only touches one adapter, never the assertion or reporting layers. Dev rules and decision log: [AGENTS.md](AGENTS.md).

## Roadmap

- **v0.1** — Claude Code adapter + `freeze`/`run`/`report` loop *(current)*
- **v0.2** — LLM-assisted assertion drafting, cache attribution (inferred), HTML report, GitHub Action
- **v0.3+** — Pi / Codex adapters

## License

[MIT](LICENSE)
