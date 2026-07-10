import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(args: string[], public exitCode: number, public output: string) {
    super(`git ${args.join(" ")} failed (exit code ${exitCode}):\n${output}`);
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

/** Parse `git status --porcelain` output into a list of file paths (renames take the new path, paths are unquoted) */
export function parsePorcelainStatus(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) {
      // git quotes and escapes non-ASCII paths
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
