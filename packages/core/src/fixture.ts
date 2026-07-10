import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** case.yaml 的顶层结构（规格书 §5.2） */
export interface FixtureCase {
  schemaVersion: "0.1";
  source: string;
  task: string;
  workspace: {
    base_ref: string;
    /** 相对 fixture 目录的路径；无未提交改动时可省略 */
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
  /** 每个 glob 必须至少匹配一个被改动的文件 */
  must_include?: string[];
  /** 任何被改动的文件都不能匹配这些 glob */
  must_not_touch?: string[];
}

export interface CommandAssertion {
  type: "command_succeeds" | "command_fails";
  command: string;
  timeout_s?: number;
}

export interface ForbiddenCommandsAssertion {
  type: "forbidden_commands";
  /** 通配模式（`*` 为通配符），对会话轨迹中每条 Bash 命令做非锚定匹配 */
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
  /** judge 断言默认 optional，不计入 pass/fail 硬指标 */
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
    super(`fixture 校验失败:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "FixtureValidationError";
  }
}

/** 校验并返回 FixtureCase，非法时抛 FixtureValidationError（含全部问题，不是遇到第一个就停） */
export function validateFixtureCase(raw: unknown): FixtureCase {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    throw new FixtureValidationError(["case.yaml 顶层必须是对象"]);
  }
  const c = raw as Record<string, unknown>;

  if (c.schemaVersion !== "0.1") issues.push(`schemaVersion 必须是 "0.1"，实际为 ${JSON.stringify(c.schemaVersion)}`);
  if (typeof c.source !== "string" || !c.source) issues.push("source 必须是非空字符串");
  if (typeof c.task !== "string" || !c.task.trim()) issues.push("task 必须是非空字符串");

  const ws = c.workspace as Record<string, unknown> | undefined;
  if (typeof ws !== "object" || ws === null) {
    issues.push("workspace 必须是对象");
  } else {
    if (typeof ws.base_ref !== "string" || !ws.base_ref) issues.push("workspace.base_ref 必须是非空字符串");
    if (ws.dirty_patch !== undefined && typeof ws.dirty_patch !== "string") issues.push("workspace.dirty_patch 必须是字符串");
  }

  if (!Array.isArray(c.allowed_tools) || c.allowed_tools.some((t) => typeof t !== "string")) {
    issues.push("allowed_tools 必须是字符串数组");
  }

  if (!Array.isArray(c.assertions)) {
    issues.push("assertions 必须是数组");
  } else {
    c.assertions.forEach((a: unknown, i: number) => {
      if (typeof a !== "object" || a === null) {
        issues.push(`assertions[${i}] 必须是对象`);
        return;
      }
      const t = (a as Record<string, unknown>).type;
      if (typeof t !== "string" || !ASSERTION_TYPES.has(t)) {
        issues.push(`assertions[${i}].type 非法: ${JSON.stringify(t)}（可选值: ${[...ASSERTION_TYPES].join(", ")}）`);
        return;
      }
      const rec = a as Record<string, unknown>;
      if ((t === "command_succeeds" || t === "command_fails") && (typeof rec.command !== "string" || !rec.command)) {
        issues.push(`assertions[${i}].command 必须是非空字符串`);
      }
      if (t === "forbidden_commands" && (!Array.isArray(rec.patterns) || rec.patterns.length === 0)) {
        issues.push(`assertions[${i}].patterns 必须是非空数组`);
      }
      if (t === "judge" && typeof rec.rubric !== "string") {
        issues.push(`assertions[${i}].rubric 必须是字符串`);
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
