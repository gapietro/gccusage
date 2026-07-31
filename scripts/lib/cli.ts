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

function checkDir(value: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(value);
  } catch {
    return `${DIR_FLAG}: no such directory: ${value}`;
  }
  return stat.isDirectory() ? null : `${DIR_FLAG}: not a directory: ${value}`;
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
