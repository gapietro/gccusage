import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionPaths {
  sessionId: string;
  /** Anonymised project label, e.g. "proj-a". Never a real directory name. */
  projectLabel: string;
  mainPath: string;
  subagentPaths: string[];
}

/** 0 -> "proj-a", 25 -> "proj-z", 26 -> "proj-aa". */
export function projectLabel(index: number): string {
  let suffix = "";
  let n = index;
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `proj-${suffix}`;
}

/**
 * Where Claude Code keeps its transcripts.
 *
 * Uses `os.homedir()` rather than `process.env.HOME`: on Windows only
 * `USERPROFILE` is set, and an unset or empty `HOME` made `path.join` return
 * a *relative* `.claude/projects`, which then resolved against the current
 * working directory and quietly produced an all-zero report.
 *
 * `os.homedir()` closes the unset case but not the empty one — it returns `""`
 * verbatim when `HOME` is set-but-empty — so the passwd entry backs it up.
 */
export function defaultProjectsDir(): string {
  return path.join(homeDir(), ".claude", "projects");
}

function homeDir(): string {
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

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Enumerate main session transcripts and their subagent transcripts.
 *
 * Subagent work is found through the `subagents/` directory, NOT through
 * the `isSidechain` field — that field is false on every record in the
 * corpus, so a reader trusting it reports zero delegation and is silently
 * wrong. Sibling `tool-results/` and `memory/` directories are skipped:
 * they hold spilled payloads and notes, not token accounting.
 *
 * Project directories are sorted before labelling so labels are stable
 * across runs. Real directory names never leave this function.
 */
export function discoverSessions(projectsDir: string): SessionPaths[] {
  const projectDirs = listDir(projectsDir)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const sessions: SessionPaths[] = [];

  projectDirs.forEach((projectName, index) => {
    const label = projectLabel(index);
    const projectPath = path.join(projectsDir, projectName);

    for (const entry of listDir(projectPath)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      const sessionId = entry.name.slice(0, -".jsonl".length);
      const subagentDir = path.join(projectPath, sessionId, "subagents");
      const subagentPaths = listDir(subagentDir)
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(subagentDir, e.name))
        .sort();

      sessions.push({
        sessionId,
        projectLabel: label,
        mainPath: path.join(projectPath, entry.name),
        subagentPaths,
      });
    }
  });

  return sessions;
}
