import * as path from "node:path";
import * as fs from "node:fs";

export function getClaudeDataDir(): string {
  const home = process.env["HOME"] || "~";
  // Claude Code stores data in ~/.claude
  return path.join(home, ".claude");
}

export function getProjectsDir(): string {
  return path.join(getClaudeDataDir(), "projects");
}

export function getCacheDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg) return path.join(xdg, "gccusage");
  return path.join(process.env["HOME"] || "~", ".cache", "gccusage");
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function findJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function findSessionJsonlFiles(sessionId?: string): string[] {
  // Fail closed: without a session id we would otherwise scan every
  // transcript across every project.
  if (!sessionId) return [];

  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const files: string[] = [];
  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, projectDir);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      const jsonlFiles = findJsonlFiles(fullPath);
      files.push(...jsonlFiles.filter((f) => path.basename(f, ".jsonl") === sessionId));
    }
  } catch {
    // ignore
  }
  return files;
}

export function findTodayJsonlFiles(): string[] {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const files: string[] = [];
  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, projectDir);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      for (const f of findJsonlFiles(fullPath)) {
        const fstat = fs.statSync(f);
        if (fstat.mtimeMs >= todayMs) {
          files.push(f);
        }
      }
    }
  } catch {
    // ignore
  }
  return files;
}
