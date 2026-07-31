// The statusline's stdout is the only channel a user reliably sees — there is
// no visible stderr in statusline mode — so a config failure is rendered as
// the bar rather than beside it.

// Written as a literal escape rather than via chalk: chalk.level is 0 when
// stdout is a pipe and is only forced to 3 inside render/powerline.ts, so
// using chalk here would mean importing that module for its side effect to
// color a single line.
const BOLD_RED = "[1;31m";
const RESET = "[0m";

/** Collapse $HOME to `~` so the line stays short enough to read at a glance. */
function shortenPath(filePath: string): string {
  const home = process.env["HOME"];
  // A HOME of "/" would prefix-match every absolute path.
  if (!home || home === "/" || !filePath.startsWith(home)) return filePath;
  return `~${filePath.slice(home.length)}`;
}

/**
 * One line, no trailing newline — matching what `runStatusline` returns, since
 * this replaces it. U+26A0 is not a Nerd Font glyph, so it renders in the same
 * terminals the default `▶` separator targets.
 */
export function formatConfigError(error: string, configPath: string): string {
  return `${BOLD_RED}⚠ gccusage config${RESET}  ${shortenPath(configPath)} — ${error}`;
}
