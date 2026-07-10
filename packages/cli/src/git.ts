import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(args: string[], public exitCode: number, public output: string) {
    super(`git ${args.join(" ")} 失败（退出码 ${exitCode}）:\n${output}`);
    this.name = "GitError";
  }
}

export function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new GitError(args, r.status ?? 1, [r.stdout, r.stderr].filter(Boolean).join("\n"));
  return r.stdout;
}

export function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

/** 解析 `git status --porcelain` 输出为文件路径列表（rename 取新路径，路径去引号） */
export function parsePorcelainStatus(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      // git 对非 ASCII 路径加引号并转义
      try {
        p = JSON.parse(p);
      } catch {
        p = p.slice(1, -1);
      }
    }
    files.push(p.replace(/\\/g, "/"));
  }
  return files;
}
