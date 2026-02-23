import { execSync } from "node:child_process";

function exec(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function getGitBranch(cwd?: string): string | null {
  return exec("git rev-parse --abbrev-ref HEAD", cwd);
}

export interface GitChanges {
  added: number;
  modified: number;
  deleted: number;
}

export function getGitChanges(cwd?: string): GitChanges | null {
  const output = exec("git status --porcelain", cwd);
  if (output === null) return null;

  const changes: GitChanges = { added: 0, modified: 0, deleted: 0 };
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const code = line.substring(0, 2);
    if (code.includes("?") || code.includes("A")) changes.added++;
    else if (code.includes("D")) changes.deleted++;
    else changes.modified++;
  }
  return changes;
}
