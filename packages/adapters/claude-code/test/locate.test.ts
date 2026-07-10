import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findSessionFile,
  listSessionFiles,
  sanitizeCwdForProjectDir,
} from "@harnesslab/adapter-claude-code";

const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harnesslab-test-"));
const fakeCwd = "E:\\proj\\demo";
const projDir = path.join(fakeClaudeDir, "projects", sanitizeCwdForProjectDir(fakeCwd));
fs.mkdirSync(projDir, { recursive: true });

fs.writeFileSync(path.join(projDir, "session-old.jsonl"), "{}");
fs.writeFileSync(path.join(projDir, "session-new.jsonl"), "{}");
fs.writeFileSync(path.join(projDir, "not-a-session.txt"), "x");
// Ensure the mtimes have a deterministic order
const past = new Date(Date.now() - 60_000);
fs.utimesSync(path.join(projDir, "session-old.jsonl"), past, past);

afterAll(() => fs.rmSync(fakeClaudeDir, { recursive: true, force: true }));

describe("sanitizeCwdForProjectDir", () => {
  it("matches Claude Code's observed rule: every non-alphanumeric character becomes -", () => {
    expect(sanitizeCwdForProjectDir("E:\\MyProgram\\harnesslab")).toBe("E--MyProgram-harnesslab");
    expect(sanitizeCwdForProjectDir("/home/user/my.proj")).toBe("-home-user-my-proj");
  });
});

describe("listSessionFiles / findSessionFile", () => {
  it("lists only .jsonl files, newest first by mtime", () => {
    const files = listSessionFiles(fakeCwd, fakeClaudeDir);
    expect(files.map((f) => f.sessionId)).toEqual(["session-new", "session-old"]);
  });

  it("defaults to the newest; excludeSessionId can exclude the current session itself", () => {
    expect(findSessionFile({ cwd: fakeCwd, claudeDir: fakeClaudeDir })?.sessionId).toBe("session-new");
    expect(
      findSessionFile({ cwd: fakeCwd, claudeDir: fakeClaudeDir, excludeSessionId: "session-new" })?.sessionId,
    ).toBe("session-old");
  });

  it("finds an exact match by id; falls back to a global scan when not found in this project's directory", () => {
    expect(findSessionFile({ cwd: fakeCwd, sessionId: "session-old", claudeDir: fakeClaudeDir })?.sessionId).toBe("session-old");

    const otherProj = path.join(fakeClaudeDir, "projects", "other-proj");
    fs.mkdirSync(otherProj, { recursive: true });
    fs.writeFileSync(path.join(otherProj, "elsewhere.jsonl"), "{}");
    expect(findSessionFile({ cwd: fakeCwd, sessionId: "elsewhere", claudeDir: fakeClaudeDir })?.filePath).toContain("other-proj");
  });

  it("returns empty for a directory that doesn't exist", () => {
    expect(listSessionFiles("Z:\\nowhere", fakeClaudeDir)).toEqual([]);
    expect(findSessionFile({ cwd: "Z:\\nowhere", claudeDir: fakeClaudeDir })).toBeUndefined();
  });
});
