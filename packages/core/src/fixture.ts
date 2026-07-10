import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Top-level structure of case.yaml (spec §5.2) */
export interface FixtureCase {
  schemaVersion: "0.1";
  source: string;
  task: string;
  workspace: {
    base_ref: string;
    /** Path relative to the fixture directory; omit when there are no uncommitted changes */
    dirty_patch?: string;
  };
  allowed_tools: string[];
  assertions: Assertion[];
  metadata?: {
    frozenAt?: string;
    originalSessionId?: string;
    originalCostUsd?: number;
    originalTotalTokens?: number;
    originalTurns?: number;
  };
}

export type Assertion =
  | FilesChangedAssertion
  | CommandAssertion
  | ForbiddenCommandsAssertion
  | BudgetAssertion
  | JudgeAssertion;

export interface FilesChangedAssertion {
  type: "files_changed";
  /** Each glob must match at least one changed file */
  must_include?: string[];
  /** No changed file may match any of these globs */
  must_not_touch?: string[];
}

export interface CommandAssertion {
  type: "command_succeeds" | "command_fails";
  command: string;
  timeout_s?: number;
}

export interface ForbiddenCommandsAssertion {
  type: "forbidden_commands";
  /** Wildcard patterns (`*` as the wildcard), matched unanchored against every Bash command in the session trace */
  patterns: string[];
}

export interface BudgetAssertion {
  type: "budget";
  max_total_tokens?: number;
  max_turns?: number;
  max_cost_usd?: number;
}

export interface JudgeAssertion {
  type: "judge";
  rubric: string;
  /** judge assertions default to optional; they never count toward the hard pass/fail verdict */
  optional?: boolean;
}

const ASSERTION_TYPES = new Set([
  "files_changed",
  "command_succeeds",
  "command_fails",
  "forbidden_commands",
  "budget",
  "judge",
]);

export class FixtureValidationError extends Error {
  constructor(public issues: string[]) {
    super(`fixture validation failed:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "FixtureValidationError";
  }
}

/** Validate and return a FixtureCase; throws FixtureValidationError (with every issue, not just the first) when invalid */
export function validateFixtureCase(raw: unknown): FixtureCase {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    throw new FixtureValidationError(["the top level of case.yaml must be an object"]);
  }
  const c = raw as Record<string, unknown>;

  if (c.schemaVersion !== "0.1") issues.push(`schemaVersion must be "0.1", got ${JSON.stringify(c.schemaVersion)}`);
  if (typeof c.source !== "string" || !c.source) issues.push("source must be a non-empty string");
  if (typeof c.task !== "string" || !c.task.trim()) issues.push("task must be a non-empty string");

  const ws = c.workspace as Record<string, unknown> | undefined;
  if (typeof ws !== "object" || ws === null) {
    issues.push("workspace must be an object");
  } else {
    if (typeof ws.base_ref !== "string" || !ws.base_ref) issues.push("workspace.base_ref must be a non-empty string");
    if (ws.dirty_patch !== undefined && typeof ws.dirty_patch !== "string") issues.push("workspace.dirty_patch must be a string");
  }

  if (!Array.isArray(c.allowed_tools) || c.allowed_tools.some((t) => typeof t !== "string")) {
    issues.push("allowed_tools must be an array of strings");
  }

  if (!Array.isArray(c.assertions)) {
    issues.push("assertions must be an array");
  } else {
    c.assertions.forEach((a: unknown, i: number) => {
      if (typeof a !== "object" || a === null) {
        issues.push(`assertions[${i}] must be an object`);
        return;
      }
      const t = (a as Record<string, unknown>).type;
      if (typeof t !== "string" || !ASSERTION_TYPES.has(t)) {
        issues.push(`assertions[${i}].type is invalid: ${JSON.stringify(t)} (valid values: ${[...ASSERTION_TYPES].join(", ")})`);
        return;
      }
      const rec = a as Record<string, unknown>;
      if ((t === "command_succeeds" || t === "command_fails") && (typeof rec.command !== "string" || !rec.command)) {
        issues.push(`assertions[${i}].command must be a non-empty string`);
      }
      if (t === "forbidden_commands" && (!Array.isArray(rec.patterns) || rec.patterns.length === 0)) {
        issues.push(`assertions[${i}].patterns must be a non-empty array`);
      }
      if (t === "judge" && typeof rec.rubric !== "string") {
        issues.push(`assertions[${i}].rubric must be a string`);
      }
    });
  }

  if (issues.length > 0) throw new FixtureValidationError(issues);
  return raw as FixtureCase;
}

export function parseFixtureCase(yamlText: string): FixtureCase {
  return validateFixtureCase(parseYaml(yamlText));
}

export function serializeFixtureCase(fixture: FixtureCase): string {
  return stringifyYaml(fixture, { lineWidth: 0 });
}
