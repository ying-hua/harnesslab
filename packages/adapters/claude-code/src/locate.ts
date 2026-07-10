import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Locate Claude Code session JSONL files.
 * Sessions are stored at ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl,
 * where the directory name replaces every non-alphanumeric character in cwd with "-"
 * (observed: `E:\MyProgram\harnesslab` -> `E--MyProgram-harnesslab`).
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

/** List every session file for a given working directory, newest first by mtime */
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
 * Find the target session file.
 * - sessionId given -> look for an exact <id>.jsonl match (first in the current cwd's project
 *   directory, then a global scan if not found there)
 * - otherwise -> the newest file in the current cwd's project directory
 */
export function findSessionFile(opts: {
  cwd: string;
  sessionId?: string;
  claudeDir?: string;
  /** freeze usually runs right after a session ends, so the newest file may be "the session running freeze itself"; allow excluding it */
  excludeSessionId?: string;
}): SessionFileInfo | undefined {
  const files = listSessionFiles(opts.cwd, opts.claudeDir);

  if (opts.sessionId) {
    const local = files.find((f) => f.sessionId === opts.sessionId);
    if (local) return local;
    // Global scan (the session may belong to a different project directory, e.g. a worktree)
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
