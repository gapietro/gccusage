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

export function getCacheDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg) return path.join(xdg, "gccusage");
  return path.join(getHomeDir(), ".cache", "gccusage");
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
  if (!fs.existsSync(projectsDir)) return none;

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
  if (!fs.existsSync(projectsDir)) return [];

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
