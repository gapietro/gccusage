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

/**
 * The same treatment for a payload that could not be read at all (#83).
 *
 * Unlike a config error this is not the user's to fix — it means Claude Code
 * sent something unusable — but showing it still beats the alternative, which
 * was a `$0.00` bar indistinguishable from a genuinely free session. Bad
 * individual fields never reach here; the schema absorbs those.
 */
export function formatStdinError(error: string): string {
  return `${BOLD_RED}⚠ gccusage${RESET}  ${error}`;
}

/**
 * A payload that never arrived (#87), as distinct from one that arrived
 * unusable (`formatStdinError`). Naming the deadline is what separates
 * "Claude Code is wedged" from "Claude Code sent garbage" for the reader.
 *
 * Written to stdout and followed by a normal exit: Claude Code only renders
 * statusline output when the command exits 0, so a non-zero exit would blank
 * the bar and throw this message away.
 */
export function formatStdinTimeout(timeoutMs: number): string {
  return `${BOLD_RED}⚠ gccusage${RESET}  stdin did not arrive within ${formatDeadline(timeoutMs)} — Claude Code may be overloaded`;
}

/**
 * Not `formatDuration` from utils/format.ts: that floors to whole seconds and
 * renders a 200ms test deadline as "0s".
 */
function formatDeadline(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${ms / 1000}s`;
}
