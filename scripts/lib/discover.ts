import * as fs from "node:fs";
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

export function defaultProjectsDir(): string {
  return path.join(process.env["HOME"] ?? "", ".claude", "projects");
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
