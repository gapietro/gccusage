import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";

/**
 * The user's home directory as an absolute path, or null when there is no
 * trustworthy answer.
 *
 * os.homedir() honours HOME on POSIX and USERPROFILE on Windows, but returns
 * an empty string when HOME is set-but-empty, and throws when HOME is unset
 * and there is no passwd entry. The passwd entry is the fallback for both.
 *
 * Past that there is deliberately nothing. This used to fall back to
 * `os.tmpdir()`, which on Linux is the shared, world-writable `/tmp`: any
 * local user could plant `/tmp/.config/gccusage/settings.json` and have its
 * `custom-command` run as the victim on every render, and the cache, setup's
 * settings.json and the transcript scan all followed it there (SEC-004,
 * review of #154). `os.tmpdir()` also honours a relative TMPDIR. Every caller
 * treats null as "no such directory": no config, no cache, no transcripts.
 */
export function getHomeDir(): string | null {
  try {
    const home = os.homedir();
    if (path.isAbsolute(home)) return home;
  } catch {
    // HOME unset and no passwd entry: os.homedir() throws. Try userInfo anyway.
  }
  try {
    const fromPasswd = os.userInfo().homedir;
    if (path.isAbsolute(fromPasswd)) return fromPasswd;
  } catch {
    // No passwd entry (some containers).
  }
  return null;
}

/** `~/.claude`, where Claude Code keeps its data, or null with no home. */
export function getClaudeDataDir(): string | null {
  const home = getHomeDir();
  return home === null ? null : path.join(home, ".claude");
}

/** Claude Code's transcript tree, or null with no home: then none are read. */
export function getProjectsDir(): string | null {
  const dataDir = getClaudeDataDir();
  return dataDir === null ? null : path.join(dataDir, "projects");
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

/**
 * The cache directory, or null when there is neither an absolute
 * XDG_CACHE_HOME nor a home directory — and then nothing is cached.
 *
 * Disabled rather than relocated. The alternative was a private
 * `<tmpdir>/gccusage-<uid>`, but that dir has to be verified (created 0700,
 * not a symlink, owned by us, no group/other bits) and a failed verification
 * still needs this same disabled path — so it would add a second code path,
 * with its own races, on top of the one it cannot avoid. Every cache here is
 * an optimisation: with none, the bar still renders, it just recomputes, and
 * the daily store reports this session's spend marked uncertain.
 */
export function getCacheDir(): string | null {
  const xdg = xdgBaseDir("XDG_CACHE_HOME");
  if (xdg) return path.join(xdg, "gccusage");
  const home = getHomeDir();
  return home === null ? null : path.join(home, ".cache", "gccusage");
}

/**
 * Lives here, beside `getCacheDir`, so both are built on `getHomeDir()`. It
 * used to sit in config/loader.ts as `HOME || "~"`, which for an unset or
 * empty HOME is the relative path `~/.config/gccusage`. That resolves against
 * the cwd, so a repo committing that path had its config, and its
 * `custom-command`, loaded and run (SEC-004, reproduced via clone).
 *
 * Null when there is neither an absolute XDG_CONFIG_HOME nor a home: then
 * there is no config file and the defaults apply. Never a shared directory.
 */
export function getConfigDir(): string | null {
  const xdg = xdgBaseDir("XDG_CONFIG_HOME");
  if (xdg) return path.join(xdg, "gccusage");
  const home = getHomeDir();
  return home === null ? null : path.join(home, ".config", "gccusage");
}

/**
 * Create `dir`, and any missing parents, as 0700 (SEC-003). The cache holds
 * session ids and per-session spend, and at the umask default of 0755 any
 * local user could list and read them.
 *
 * The mode applies only to directories this call creates. One that already
 * exists — `~/.cache` itself, say — is the user's, and its mode is their
 * choice, so nothing here chmods it.
 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  if (projectsDir === null || !fs.existsSync(projectsDir)) return [];

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
  if (projectsDir === null || !fs.existsSync(projectsDir)) return [];

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
