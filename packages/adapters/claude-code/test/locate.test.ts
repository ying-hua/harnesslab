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
// 保证 mtime 有确定的先后顺序
const past = new Date(Date.now() - 60_000);
fs.utimesSync(path.join(projDir, "session-old.jsonl"), past, past);

afterAll(() => fs.rmSync(fakeClaudeDir, { recursive: true, force: true }));

describe("sanitizeCwdForProjectDir", () => {
  it("与 Claude Code 实测规则一致：非字母数字全部替换为 -", () => {
    expect(sanitizeCwdForProjectDir("E:\\MyProgram\\harnesslab")).toBe("E--MyProgram-harnesslab");
    expect(sanitizeCwdForProjectDir("/home/user/my.proj")).toBe("-home-user-my-proj");
  });
});

describe("listSessionFiles / findSessionFile", () => {
  it("只列 .jsonl，按 mtime 倒序", () => {
    const files = listSessionFiles(fakeCwd, fakeClaudeDir);
    expect(files.map((f) => f.sessionId)).toEqual(["session-new", "session-old"]);
  });

  it("默认取最新；excludeSessionId 可排除当前会话自身", () => {
    expect(findSessionFile({ cwd: fakeCwd, claudeDir: fakeClaudeDir })?.sessionId).toBe("session-new");
    expect(
      findSessionFile({ cwd: fakeCwd, claudeDir: fakeClaudeDir, excludeSessionId: "session-new" })?.sessionId,
    ).toBe("session-old");
  });

  it("按 id 精确查找；本项目目录找不到时全局扫", () => {
    expect(findSessionFile({ cwd: fakeCwd, sessionId: "session-old", claudeDir: fakeClaudeDir })?.sessionId).toBe("session-old");

    const otherProj = path.join(fakeClaudeDir, "projects", "other-proj");
    fs.mkdirSync(otherProj, { recursive: true });
    fs.writeFileSync(path.join(otherProj, "elsewhere.jsonl"), "{}");
    expect(findSessionFile({ cwd: fakeCwd, sessionId: "elsewhere", claudeDir: fakeClaudeDir })?.filePath).toContain("other-proj");
  });

  it("不存在的目录返回空", () => {
    expect(listSessionFiles("Z:\\nowhere", fakeClaudeDir)).toEqual([]);
    expect(findSessionFile({ cwd: "Z:\\nowhere", claudeDir: fakeClaudeDir })).toBeUndefined();
  });
});
