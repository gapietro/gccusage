/**
 * The terminal's width in columns, or `undefined` when it cannot be known.
 *
 * `process.stdout.columns` is undefined whenever stdout is not a TTY, and
 * Claude Code always pipes the statusline's stdout — the same reason
 * `powerline.ts` has to force `chalk.level = 3`. This returned `|| 80` for
 * every user in every terminal (issue #67).
 *
 * Claude Code compensates in its hook spawner: it reads `process.stdout.columns`
 * from its own process — which is a real TTY — and injects `COLUMNS` (and
 * `LINES`) into the child's environment on every spawn, so the value tracks
 * live terminal resizes. Verified against the 2.1.220 binary.
 *
 * The live TTY value is preferred when we have one: someone running `gccusage`
 * directly in a terminal has an accurate `stdout.columns`, while a
 * shell-exported `COLUMNS` can be stale.
 *
 * A malformed value degrades to `undefined` rather than to a coerced number,
 * because every consumer treats unknown as "leave the output alone" and a
 * wrong number silently mangles the bar.
 */
export function getTerminalWidth(): number | undefined {
  const fromTty = process.stdout.columns;
  if (typeof fromTty === "number" && Number.isInteger(fromTty) && fromTty > 0) {
    return fromTty;
  }

  const fromEnv = process.env["COLUMNS"];
  if (fromEnv === undefined || fromEnv.trim() === "") return undefined;
  const parsed = Number(fromEnv);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}
