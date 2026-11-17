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

/**
 * `p` with the home directory collapsed to `~`, for display.
 *
 * Only on a path-segment boundary: a bare `startsWith(home)` turned
 * `/home/u2/x` into `~2/x` when home was `/home/u` (review of #154). With no
 * home, or a home of "/" (which would prefix-match every absolute path),
 * nothing is collapsed. The one owner for the error line and the cwd widget.
 */
export function collapseHome(p: string): string {
  const home = getHomeDir();
  if (home === null || home === "/") return p;
  if (p === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return p.startsWith(prefix) ? `~${path.sep}${p.slice(prefix.length)}` : p;
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
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  reportIgnoredXdg(name, value);
  return undefined;
}

/** `NAME=value` pairs already reported, so each is logged once per process. */
const reportedXdg = new Set<string>();

/**
 * Ignoring a relative value moves the cache or config somewhere the user did
 * not ask for, silently. Say so under GCCUSAGE_DEBUG (review of #154) — once
 * per value, since getCacheDir runs many times per render.
 */
function reportIgnoredXdg(name: string, value: string): void {
  if (!process.env["GCCUSAGE_DEBUG"]) return;
  const key = `${name}=${value}`;
  if (reportedXdg.has(key)) return;
  reportedXdg.add(key);
  console.error(`gccusage: ignoring relative ${name}=${JSON.stringify(value)} — the XDG spec requires an absolute path`);
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

/**
 * Strip group and other permission bits from an EXISTING cache tree: the
 * cache dir, its direct subdirectories (`daily/`, `blocks/`), and the files
 * at those two levels (SEC-003, review of #154).
 *
 * `ensureDir` only narrows directories it creates, and cache files only
 * become 0600 when rewritten, so an install from before SEC-003 kept a 0755
 * `~/.cache/gccusage`, a 0755 `daily/`, and 0644 shards for sessions that
 * never write again. This is the one-time fix-up for that.
 *
 * Bits are only ever removed (`mode & ~0o077`), never set, so this cannot
 * widen anything. Each entry is lstat'ed and skipped if it is a symlink or
 * is not owned by this uid: the tree is ours, but a link inside it could
 * point anywhere, and someone else's file is not ours to change. Skipped
 * entirely where there is no uid (Windows).
 *
 * Not run on the render path. Its callers are the detached refresh child
 * and `setup`. It needs no "done" marker: once the tree is narrowed, every
 * pass is a stat walk over a few dozen entries that changes nothing, at
 * the refresh cadence. A marker would be more state to get wrong, for a
 * saving no one would notice.
 */
export function narrowCacheModes(cacheDir: string): void {
  if (typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (!narrowOwned(cacheDir, uid, true)) return;

  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    const entry = path.join(cacheDir, name);
    if (!narrowOwned(entry, uid, true)) continue; // Files: narrowed, nothing to walk.
    let inner: string[];
    try {
      inner = fs.readdirSync(entry);
    } catch {
      continue;
    }
    for (const innerName of inner) narrowOwned(path.join(entry, innerName), uid, false);
  }
}

/**
 * Narrow one entry if it is ours and not a link. Returns true only for a
 * directory the caller may walk into. With `dirsToo` false, a directory is
 * left as found — the walk's depth limit.
 */
function narrowOwned(p: string, uid: number, dirsToo: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || st.uid !== uid) return false;
  const isDir = st.isDirectory();
  if (!st.isFile() && !isDir) return false;
  if (isDir && !dirsToo) return false;

  const current = st.mode & 0o777;
  const narrowed = current & ~0o077;
  if (narrowed !== current) {
    try {
      fs.chmodSync(p, narrowed);
    } catch {
      // Best effort: the next pass retries.
    }
  }
  return isDir;
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

// A subagent transcript's name. Matched by name, not by extension: a workflow
// run's directory also holds a `journal.jsonl` that is not a transcript, and
// each agent has an `agent-<id>.meta.json` beside it.
const SUBAGENT_TRANSCRIPT = /^agent-.*\.jsonl$/;

/** The agent transcripts in `dir`, or null when `dir` cannot be listed. */
function subagentTranscriptsIn(dir: string): string[] | null {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => SUBAGENT_TRANSCRIPT.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return null;
  }
}

/**
 * The subagent transcripts of one session, given the session's directory
 * (`<project>/<sessionId>/`). COR-007: Claude Code writes a subagent's usage
 * to its own transcript there, never to the parent `<sessionId>.jsonl`, so a
 * walk of top-level transcripts alone misses it: 14.6% of tokens over the
 * audit's 7-day window on the developer's machine.
 *
 * Two fixed locations, no recursion:
 * - `subagents/agent-<id>.jsonl` — Task-tool agents;
 * - `subagents/workflows/<run>/agent-<id>.jsonl` — agents a workflow spawned.
 *   On the developer's machine these were 193 of 326 subagent transcripts
 *   and 0.63B of 2.23B subagent tokens, so a flat read of `subagents/` alone
 *   would leave much of COR-007 in place.
 * A missing or unreadable directory at either level yields nothing for that
 * level and never throws, so it cannot cost the caller the main transcript.
 *
 * Message ids are deduplicated per file only (`parseJsonlContent`), and that
 * is deliberate. Of 8,098 Task-agent message ids, 1 also appears in a parent
 * transcript (~0.01%; 1 of 1,688 in the audit's sample), and none of 4,516
 * workflow-agent ids appears anywhere else. Today's figure is aggregated and
 * cached PER FILE (`today-aggregate-cache.ts`), so cross-file dedup there would
 * mean persisting every file's message ids and invalidating across files.
 * Doing it for the session total alone would make the session and Today
 * disagree about the same responses. The cost of not doing it is an
 * over-count bounded by that overlap, against a ~15% under-count fixed.
 */
function findSubagentJsonlFiles(sessionDir: string): string[] {
  const subagentsDir = path.join(sessionDir, "subagents");
  const files = subagentTranscriptsIn(subagentsDir);
  // Most session dirs have no `subagents/` (ENOENT), and then `workflows/`
  // under it cannot exist either. Stopping here halves the failed readdirs
  // per session dir on every render. Any other failure (ENOTDIR, EACCES) is
  // treated alike: a child of a dir that cannot be listed is not looked for.
  if (files === null) return [];

  const workflowsDir = path.join(subagentsDir, "workflows");
  let runs: string[];
  try {
    runs = fs.readdirSync(workflowsDir);
  } catch {
    return files;
  }
  for (const run of runs) {
    // A non-directory entry just fails its readdir with ENOTDIR.
    files.push(...(subagentTranscriptsIn(path.join(workflowsDir, run)) ?? []));
  }
  return files;
}

export interface SessionTranscripts {
  /** `<project>/<sessionId>.jsonl`: where the session and its prompts live. */
  main: string[];
  /** Its subagents' transcripts (COR-007). */
  subagents: string[];
}

/**
 * Every transcript of one session, split by kind. Callers that need to know
 * where the session started, or what the user typed, read `main`; nothing
 * depends on the order of either list.
 */
export function findSessionTranscripts(sessionId?: string): SessionTranscripts {
  const none: SessionTranscripts = { main: [], subagents: [] };
  // Fail closed: without a session id we would otherwise scan every
  // transcript across every project.
  if (!sessionId) return none;

  const projectsDir = getProjectsDir();
  if (projectsDir === null || !fs.existsSync(projectsDir)) return none;

  // The id arrives from stdin. It used to be compared only against basenames;
  // the subagent lookup joins it into a path, so an id that is not a plain
  // UUID-like token ("../x") skips that lookup rather than walking out of the
  // project directory.
  const joinable = SAFE_SESSION_ID.test(sessionId);

  const mainFiles: string[] = [];
  const subagentFiles: string[] = [];
  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, projectDir);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      const jsonlFiles = findJsonlFiles(fullPath);
      mainFiles.push(...jsonlFiles.filter((f) => path.basename(f, ".jsonl") === sessionId));
      if (joinable) subagentFiles.push(...findSubagentJsonlFiles(path.join(fullPath, sessionId)));
    }
  } catch {
    // ignore
  }
  return { main: mainFiles, subagents: subagentFiles };
}

/** Every transcript of one session, main and subagent alike (COR-007). */
export function findSessionJsonlFiles(sessionId?: string): string[] {
  const { main, subagents } = findSessionTranscripts(sessionId);
  return [...main, ...subagents];
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
 *
 * Includes each session's subagent transcripts (COR-007). The session
 * directories are found from the one `readdir` per project this walk already
 * does, via its entry types, so the added cost is one failed `readdir` per
 * session directory without subagents, and a stat per agent file, which the
 * cache needs anyway. Every subagent file is filtered on its own mtime, not
 * its parent's: a session left open over midnight writes today's usage to a
 * subagent while the parent's last line is yesterday's.
 *
 * The today-aggregate cache needs no change for these files: it keys on the
 * path, so a subagent file is just another key, and one missing from a cache
 * written before this walk saw them is a miss that gets parsed and added.
 */
export function findTodayJsonlFileStats(): TodayJsonlFile[] {
  const projectsDir = getProjectsDir();
  if (projectsDir === null || !fs.existsSync(projectsDir)) return [];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const files: TodayJsonlFile[] = [];
  // Each stat has its own catch: a file that vanishes between the readdir and
  // the stat (an agent transcript being cleaned up, say) skips that file
  // rather than escaping to the outer catch and costing every transcript
  // after it.
  const addIfToday = (f: string): void => {
    try {
      const fstat = fs.statSync(f);
      if (fstat.mtimeMs >= todayMs) {
        files.push({ path: f, mtimeMs: fstat.mtimeMs, size: fstat.size });
      }
    } catch {
      // skip it
    }
  };
  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, projectDir);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      // Unreadable project dir: skipped, as `findJsonlFiles` did before.
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(fullPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name);
        if (entry.name.endsWith(".jsonl")) {
          addIfToday(entryPath);
        } else if (entry.isDirectory()) {
          for (const f of findSubagentJsonlFiles(entryPath)) addIfToday(f);
        }
      }
    }
  } catch {
    // ignore
  }
  return files;
}
