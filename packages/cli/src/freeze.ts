import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import pc from "picocolors";
import {
  serializeFixtureCase,
  sumSessionTokens,
  type Assertion,
  type FixtureCase,
  type UnifiedSession,
} from "@harnesslab/core";
import { findSessionFile, parseSessionFile } from "@harnesslab/adapter-claude-code";
import { git, tryGit } from "./git.js";

export interface FreezeOptions {
  last?: boolean;
  session?: string;
  output?: string;
  cwd?: string;
}

export function freeze(opts: FreezeOptions): void {
  const cwd = opts.cwd ?? process.cwd();

  // 1. Locate the session
  const info = findSessionFile({ cwd, sessionId: opts.session });
  if (!info) {
    console.error(
      pc.red(
        opts.session
          ? `Could not find session "${opts.session}" (no matching .jsonl under ~/.claude/projects)`
          : `No Claude Code session found under ${cwd}. Finish a task with Claude Code first, then freeze it.`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  console.log(pc.dim(`session: ${info.sessionId} (${Math.round(info.sizeBytes / 1024)}KB, ${info.mtime.toISOString()})`));

  // 2. Parse
  const session = parseSessionFile(info.filePath);
  for (const w of session.parseWarnings ?? []) console.log(pc.yellow(`  ⚠ ${w}`));

  const firstUserTurn = session.turns.find((t) => t.role === "user");
  if (!firstUserTurn) {
    console.error(pc.red("No user message found in the session; cannot extract a task description"));
    process.exitCode = 1;
    return;
  }
  const task = firstUserTurn.content.trim();

  // 3. Git state
  const baseRef = tryGit(["rev-parse", "HEAD"], cwd)?.trim();
  if (!baseRef) {
    console.error(pc.red(`${cwd} is not a git repository (or has no commits). freeze needs git to record workspace state.`));
    process.exitCode = 1;
    return;
  }
  const dirtyDiff = git(["diff", "HEAD"], cwd);
  const untracked = tryGit(["ls-files", "--others", "--exclude-standard"], cwd)?.trim();

  // 4. Draft assertions (deterministic heuristics; LLM-assisted generation is planned for v0.2)
  const assertions = draftAssertions(session);
  const allowedTools = draftAllowedTools(session);

  // 5. Write the fixture directory to disk
  const outDir = path.resolve(cwd, opts.output ?? path.join("cases", slugify(task) || info.sessionId.slice(0, 8)));
  fs.mkdirSync(outDir, { recursive: true });

  const hasPatch = dirtyDiff.trim().length > 0;
  if (hasPatch) fs.writeFileSync(path.join(outDir, "workspace.patch"), dirtyDiff);

  const totals = sumSessionTokens(session);
  const fixture: FixtureCase = {
    schemaVersion: "0.1",
    source: "claude-code",
    task,
    workspace: {
      base_ref: baseRef,
      ...(hasPatch ? { dirty_patch: "workspace.patch" } : {}),
    },
    allowed_tools: allowedTools,
    assertions,
    metadata: {
      frozenAt: new Date().toISOString(),
      originalSessionId: session.sessionId,
      originalTotalTokens: totals.total,
      originalTurns: session.turns.length,
    },
  };
  fs.writeFileSync(path.join(outDir, "case.yaml"), serializeFixtureCase(fixture));
  fs.writeFileSync(
    path.join(outDir, "original-session.jsonl.gz"),
    zlib.gzipSync(fs.readFileSync(info.filePath)),
  );

  // 6. Report back
  console.log(pc.green(`\n✔ fixture created: ${path.relative(cwd, outDir)}`));
  console.log(`  task: ${task.length > 80 ? task.slice(0, 80) + "…" : task}`);
  console.log(`  base_ref: ${baseRef.slice(0, 12)}${hasPatch ? " + workspace.patch" : " (clean workspace, no patch)"}`);
  console.log(`  ${assertions.length} draft assertion(s) (heuristically generated, ${pc.bold("please open case.yaml and review/edit each one")})`);
  if (untracked) {
    console.log(pc.yellow(`  ⚠ untracked files will not be included in the patch: ${untracked.split("\n").slice(0, 5).join(", ")}${untracked.split("\n").length > 5 ? " …" : ""}`));
  }
  const networkish = detectSideEffectCommands(session);
  if (networkish.length > 0) {
    console.log(pc.yellow(`  ⚠ the original session contains commands that look like network/side effects; this fixture may not be suitable for replay: ${networkish.join("; ")}`));
  }
  console.log(pc.dim(`\nnext: npx harnesslab run ${path.relative(cwd, path.join(outDir, "case.yaml"))}`));
}

/** Derive files_changed from Edit/Write-style tool calls, and budget from the original usage */
function draftAssertions(session: UnifiedSession): Assertion[] {
  const editedFiles = new Set<string>();
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(call.name)) continue;
      const fp = call.input.file_path ?? call.input.notebook_path;
      if (typeof fp !== "string") continue;
      const rel = toRelativePosix(fp, session.cwd);
      if (rel) editedFiles.add(rel);
    }
  }

  const totals = sumSessionTokens(session);
  const assertions: Assertion[] = [];
  if (editedFiles.size > 0) {
    assertions.push({ type: "files_changed", must_include: [...editedFiles].sort() });
  }
  assertions.push({ type: "forbidden_commands", patterns: ["git push", "rm -rf"] });
  assertions.push({
    type: "budget",
    // Give 2x headroom: replay variance shouldn't make the budget assertion flake daily
    max_total_tokens: Math.ceil((totals.total * 2) / 1000) * 1000 || 100_000,
    max_turns: Math.max(session.turns.length * 2, 10),
  });
  return assertions;
}

/** Dedupe non-Bash tools by name; group Bash commands into Bash(xxx *) prefix rules by their first token */
function draftAllowedTools(session: UnifiedSession): string[] {
  const tools = new Set<string>();
  const bashPrefixes = new Set<string>();
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (call.name === "Bash") {
        const cmd = typeof call.input.command === "string" ? call.input.command.trim() : "";
        const first = cmd.split(/\s+/)[0];
        if (first) bashPrefixes.add(first);
      } else {
        tools.add(call.name);
      }
    }
  }
  return [...[...tools].sort(), ...[...bashPrefixes].sort().map((p) => `Bash(${p} *)`)];
}

const SIDE_EFFECT_PATTERNS = [/\bcurl\b/, /\bwget\b/, /\bgit push\b/, /\bnpm publish\b/, /\bssh\b/, /Invoke-WebRequest/i];

function detectSideEffectCommands(session: UnifiedSession): string[] {
  const hits: string[] = [];
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (call.name !== "Bash" || typeof call.input.command !== "string") continue;
      if (SIDE_EFFECT_PATTERNS.some((re) => re.test(call.input.command as string))) {
        hits.push(call.input.command.slice(0, 60));
      }
    }
  }
  return hits;
}

function toRelativePosix(filePath: string, base: string): string | undefined {
  if (!base) return undefined;
  const rel = path.relative(base, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.replace(/\\/g, "/");
}

function slugify(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
