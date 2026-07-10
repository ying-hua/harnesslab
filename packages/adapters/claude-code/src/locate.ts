import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 定位 Claude Code 的 session JSONL 文件。
 * session 存储在 ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl，
 * 目录名规则：cwd 中所有非字母数字字符替换为 "-"
 * （实测 `E:\MyProgram\harnesslab` → `E--MyProgram-harnesslab`）。
 */

export function claudeProjectsDir(claudeDir?: string): string {
  const base = claudeDir ?? process.env.HARNESSLAB_CLAUDE_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

export function sanitizeCwdForProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface SessionFileInfo {
  sessionId: string;
  filePath: string;
  mtime: Date;
  sizeBytes: number;
}

/** 列出某个工作目录对应的全部 session 文件，按修改时间倒序（最新在前） */
export function listSessionFiles(cwd: string, claudeDir?: string): SessionFileInfo[] {
  const dir = path.join(claudeProjectsDir(claudeDir), sanitizeCwdForProjectDir(cwd));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      return {
        sessionId: path.basename(f, ".jsonl"),
        filePath,
        mtime: stat.mtime,
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/**
 * 找到目标 session 文件。
 * - sessionId 给定 → 精确找 <id>.jsonl（先在当前 cwd 的项目目录找，找不到再全局扫）
 * - 否则 → 当前 cwd 项目目录下最新的一个
 */
export function findSessionFile(opts: {
  cwd: string;
  sessionId?: string;
  claudeDir?: string;
  /** freeze 通常在 session 刚结束后运行，最新文件可能就是"运行 freeze 的这个会话"，允许排除 */
  excludeSessionId?: string;
}): SessionFileInfo | undefined {
  const files = listSessionFiles(opts.cwd, opts.claudeDir);

  if (opts.sessionId) {
    const local = files.find((f) => f.sessionId === opts.sessionId);
    if (local) return local;
    // 全局扫（session 可能属于其他项目目录，例如 worktree）
    const projectsRoot = claudeProjectsDir(opts.claudeDir);
    if (!fs.existsSync(projectsRoot)) return undefined;
    for (const projDir of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, projDir, `${opts.sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        return { sessionId: opts.sessionId, filePath: candidate, mtime: stat.mtime, sizeBytes: stat.size };
      }
    }
    return undefined;
  }

  return files.find((f) => f.sessionId !== opts.excludeSessionId);
}
