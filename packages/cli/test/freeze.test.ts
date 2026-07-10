import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFixtureCase, type FilesChangedAssertion } from "@harnesslab/core";
import { sanitizeCwdForProjectDir } from "@harnesslab/adapter-claude-code";
import { freeze } from "../src/freeze.js";
import { quoteForShell, median, stddev } from "../src/run.js";
import { parsePorcelainStatus } from "../src/git.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harnesslab-freeze-"));
const repo = path.join(tmp, "repo");
const fakeClaude = path.join(tmp, "claude-home");
afterAll(() => {
  delete process.env.HARNESSLAB_CLAUDE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gitIn(args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

describe("freeze end to end (real git repo + a faked session directory)", () => {
  it("produces a complete fixture: case.yaml + workspace.patch + compressed archive", () => {
    // Set up a repo with 1 commit plus an uncommitted change
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "auth.py"), "def check(token): ...\n");
    gitIn(["init"]);
    gitIn(["add", "-A"]);
    gitIn(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    fs.appendFileSync(path.join(repo, "auth.py"), "# WIP dirty change\n");

    // Fake a session: rewrite the golden file's cwd to point at this repo, drop it into a fake ~/.claude/projects
    const golden = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../adapters/claude-code/test/fixtures/golden-session.jsonl"),
      "utf8",
    );
    const rewritten = golden
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const obj = JSON.parse(line);
        if (obj.cwd) obj.cwd = repo;
        if (obj.message?.content?.[0]?.name === "Edit") {
          obj.message.content[0].input.file_path = path.join(repo, "src", "auth.py");
        }
        return JSON.stringify(obj);
      })
      .join("\n");
    const projDir = path.join(fakeClaude, "projects", sanitizeCwdForProjectDir(repo));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "test-session-0001.jsonl"), rewritten);
    process.env.HARNESSLAB_CLAUDE_DIR = fakeClaude;

    freeze({ cwd: repo, output: "cases/demo" });

    const caseDir = path.join(repo, "cases", "demo");
    const fixture = parseFixtureCase(fs.readFileSync(path.join(caseDir, "case.yaml"), "utf8"));

    expect(fixture.task).toContain("token expiry");
    expect(fixture.source).toBe("claude-code");
    expect(fixture.workspace.base_ref).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.workspace.dirty_patch).toBe("workspace.patch");
    expect(fs.readFileSync(path.join(caseDir, "workspace.patch"), "utf8")).toContain("WIP dirty change");
    expect(fs.existsSync(path.join(caseDir, "original-session.jsonl.gz"))).toBe(true);

    // Heuristically drafted assertions
    const filesChanged = fixture.assertions.find((a) => a.type === "files_changed") as FilesChangedAssertion;
    expect(filesChanged.must_include).toEqual(["src/auth.py"]);
    expect(fixture.assertions.some((a) => a.type === "budget")).toBe(true);
    expect(fixture.assertions.some((a) => a.type === "forbidden_commands")).toBe(true);

    // allowed_tools: non-Bash tools by name, Bash commands grouped by first token
    expect(fixture.allowed_tools).toContain("Edit");
    expect(fixture.allowed_tools).toContain("Bash(pytest *)");

    expect(fixture.metadata?.originalSessionId).toBe("test-session-0001");
    expect(fixture.metadata?.originalTotalTokens).toBeGreaterThan(0);
  });
});

describe("run's pure functions", () => {
  it("quoteForShell quotes args containing spaces/wildcards", () => {
    expect(quoteForShell("claude", ["-p", "--allowedTools", "Read,Bash(git diff *)"])).toBe(
      'claude -p --allowedTools "Read,Bash(git diff *)"',
    );
  });

  it("parsePorcelainStatus handles modified/added/renamed/quoted paths", () => {
    const out = ' M src/auth.py\n?? new file.txt\nR  old.py -> new.py\n M "\\346\\265\\213.py"\n';
    const files = parsePorcelainStatus(out);
    expect(files).toContain("src/auth.py");
    expect(files).toContain("new file.txt");
    expect(files).toContain("new.py");
    expect(files).toHaveLength(4);
  });

  it("median / stddev", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
    expect(stddev([5])).toBe(0);
  });
});
