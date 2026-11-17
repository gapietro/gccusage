import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";

// os.homedir() honours HOME on POSIX and USERPROFILE on Windows, but returns an
// empty string when HOME is set-but-empty. Fall back to the passwd entry so we
// never build a relative path that resolves against the launch directory.
export function getHomeDir(): string {
  const home = os.homedir();
  if (path.isAbsolute(home)) return home;
  try {
    const fromPasswd = os.userInfo().homedir;
    if (path.isAbsolute(fromPasswd)) return fromPasswd;
  } catch {
    // No passwd entry (some containers); fall through.
  }
  return os.tmpdir();
}

export function getClaudeDataDir(): string {
  // Claude Code stores data in ~/.claude
  return path.join(getHomeDir(), ".claude");
}

export function getProjectsDir(): string {
  return path.join(getClaudeDataDir(), "projects");
}

// The UUIDs Claude Code sends. Anything else is hashed rather than trusted: a
// session id arrives from stdin and must never reach a filesystem path
// unchecked. Used by the daily cost store (its only production caller since
// #129 deleted the turn store, which used to share this so there was one
// implementation of the rule, not two).
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function shardKey(sessionId: string): string {
  return SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

/**
 * An `XDG_*` base directory, or undefined when it is unset, empty or relative.
 *
 * The XDG Base Directory spec says a relative path in these variables is
 * invalid and must be ignored. Honouring one resolved it against the launch
 * directory, and for the config dir that meant a repo could commit
 * `.config/gccusage/settings.json` and have its `custom-command` run on every
 * render (SEC-004).
 */
function xdgBaseDir(name: "XDG_CACHE_HOME" | "XDG_CONFIG_HOME"): string | undefined {
  const value = process.env[name];
  return value && path.isAbsolute(value) ? value : undefined;
}

export function getCacheDir(): string {
  const xdg = xdgBaseDir("XDG_CACHE_HOME");
  if (xdg) return path.join(xdg, "gccusage");
  return path.join(getHomeDir(), ".cache", "gccusage");
}

/**
 * Lives here, beside `getCacheDir`, so both are built on `getHomeDir()`. It
 * used to sit in config/loader.ts as `HOME || "~"`, which for an unset or
 * empty HOME is the relative path `~/.config/gccusage`. That resolves against
 * the cwd, so a repo committing that path had its config, and its
 * `custom-command`, loaded and run (SEC-004, reproduced via clone).
 */
export function getConfigDir(): string {
  const xdg = xdgBaseDir("XDG_CONFIG_HOME");
  if (xdg) return path.join(xdg, "gccusage");
  return path.join(getHomeDir(), ".config", "gccusage");
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

export interface TodayJsonlFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Today's transcripts with the `mtimeMs` and `size` from the stat this walk
 * already performs. `today-aggregate-cache.ts` keys its reuse decision on that
 * pair, and re-statting to get it would double the syscalls the cache exists
 * to avoid.
 */
export function findTodayJsonlFileStats(): TodayJsonlFile[] {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const files: TodayJsonlFile[] = [];
  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, projectDir);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      for (const f of findJsonlFiles(fullPath)) {
        const fstat = fs.statSync(f);
        if (fstat.mtimeMs >= todayMs) {
          files.push({ path: f, mtimeMs: fstat.mtimeMs, size: fstat.size });
        }
      }
    }
  } catch {
    // ignore
  }
  return files;
}
