import * as fs from "node:fs";

export interface CliOptions {
  /** undefined means "use the default projects directory". */
  projectsDir: string | undefined;
  json: boolean;
}

export type CliResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string };

export const USAGE =
  "usage: npm run analyze [-- --json] [-- --projects-dir <path>]";

const DIR_FLAG = "--projects-dir";
const DIR_ASSIGN = `${DIR_FLAG}=`;

function checkDir(value: string, label: string = DIR_FLAG): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(value);
  } catch {
    return `${label}: no such directory: ${value}`;
  }
  return stat.isDirectory() ? null : `${label}: not a directory: ${value}`;
}

/**
 * Settle which directory to analyse, validating the default as strictly as
 * an explicit one.
 *
 * `--projects-dir` was already rejected when it did not exist, but the
 * default path was passed through unchecked — so a wrong explicit path
 * exited 1 while a wrong *default* printed a full all-zero report and
 * exited 0. That is the worse of the two: it looks like a finding about an
 * idle corpus rather than a failure to find one.
 *
 * `fallback` is injected so this is testable without mutating the
 * environment's home directory.
 */
export function resolveProjectsDir(
  options: CliOptions,
  fallback: () => string,
): { ok: true; dir: string } | { ok: false; error: string } {
  if (options.projectsDir !== undefined) return { ok: true, dir: options.projectsDir };

  const dir = fallback();
  const problem = checkDir(dir, "default projects directory");
  if (problem) {
    return {
      ok: false,
      error: `${problem}\npass ${DIR_FLAG} <path> to analyse a different location`,
    };
  }
  return { ok: true, dir };
}

/**
 * Parse the analyzer's arguments, rejecting anything it does not understand.
 *
 * Both failure modes here were silent before, and the second was the
 * dangerous one:
 *
 *   --projects-dir --json     took "--json" as the path and printed a full
 *                             all-zero report with exit 0
 *   --projekts-dir /nowhere   was ignored entirely, so the run scanned the
 *                             real $HOME corpus and printed a plausible
 *                             report the user believed came from /nowhere
 *
 * A value that looks like a flag, a missing value, a directory that is not
 * there, and any unrecognised argument are all now hard errors.
 */
export function parseArgs(argv: string[]): CliResult {
  let json = false;
  let projectsDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === DIR_FLAG) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `${DIR_FLAG} requires a path` };
      }
      const problem = checkDir(value);
      if (problem) return { ok: false, error: problem };
      projectsDir = value;
      i += 1;
      continue;
    }

    if (arg.startsWith(DIR_ASSIGN)) {
      const value = arg.slice(DIR_ASSIGN.length);
      if (value === "") return { ok: false, error: `${DIR_FLAG} requires a path` };
      const problem = checkDir(value);
      if (problem) return { ok: false, error: problem };
      projectsDir = value;
      continue;
    }

    return { ok: false, error: `unrecognised argument: ${arg}` };
  }

  return { ok: true, options: { projectsDir, json } };
}
