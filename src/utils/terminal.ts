import { displayWidth } from "./display-width.js";

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

/**
 * One complete ANSI escape sequence, as a source string.
 *
 * This used to match SGR alone (`\x1b\[[0-9;]*m`), so every other sequence a
 * terminal recognises was counted as visible text — an OSC-8 hyperlink
 * measured 37 columns for the 4 it draws, and the bar truncated itself early
 * to make room for bytes nothing renders. Issue #113. Reachable through
 * `custom-command`, which puts arbitrary shell output in the bar.
 *
 * The alternatives, in order:
 *
 * - `CSI` — `ESC [`, parameter bytes, intermediate bytes, one final byte.
 *   SGR is simply the case whose final byte is `m`.
 * - `OSC` — `ESC ]` up to a BEL or a String Terminator. Window titles and
 *   hyperlinks.
 * - `DCS` / `SOS` / `PM` / `APC` — string sequences, ST-terminated.
 * - `nF` — `ESC` plus intermediates plus a final byte, e.g. `ESC ( B`.
 * - Two-character escapes, e.g. `ESC c` (full reset), `ESC 7` (save cursor).
 *
 * **The lookahead is load-bearing; the alternation order is not.** `[0-~]`
 * spans `[`, `]`, `P`, `X`, `^` and `_`, so without the exclusion the
 * two-character alternative would match the opener of a CSI or a string
 * sequence and leave its body as visible text. It bites hardest when a
 * sequence is *unterminated*: the OSC alternative fails, and `ESC ]` would
 * then be consumed as a two-character escape, making the unmatched remainder
 * look like ordinary text at a two-byte discount. None of those six bytes is
 * ever a standalone escape, so excluding them is a correction, not a
 * workaround.
 *
 * Ordering was originally documented here as the mechanism. It is not — moving
 * the two-character alternative first leaves every test green, because the
 * lookahead already prevents the overlap. Listing it last is readability only.
 *
 * Every alternative is linear with no nested quantifier, so this cannot
 * backtrack catastrophically. That matters more here than usual: the input is
 * arbitrary shell output, and `ansi-regex` — the obvious dependency to reach
 * for instead — carried a ReDoS advisory (GHSA-93q8-gq69-wqmw) on this exact
 * shape of pattern. The grammar is frozen (ECMA-48), unlike the Unicode width
 * data that justified taking `get-east-asian-width` as a dependency in #86.
 */
const ESCAPE_SEQUENCE = String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[ -/]+[0-~]|(?![[\]PX^_])[0-~])`;

const ESCAPE_ANYWHERE = new RegExp(ESCAPE_SEQUENCE, "g");
const ESCAPE_AT = new RegExp(ESCAPE_SEQUENCE, "y");

/**
 * C0 control characters that drive the terminal without drawing anything.
 *
 * Same defect as the escapes above, one step out: a `CR` or `BEL` in a
 * command's output counted as a column it never occupies.
 *
 * Three deliberate holes:
 *
 * - **TAB** (0x09), because its width depends on the cursor's position against
 *   the next tab stop, which is not knowable statically. Counting it as 1 is a
 *   floor, and a floor can only over-measure, never overflow.
 * - **LF** (0x0A), because the bar is two lines and callers `split("\n")` the
 *   output of `stripAnsi`. It is a structural separator here, not decoration —
 *   removing it collapsed the two-line bar into one 90-column line and turned
 *   four assertions in `default-layout-width.test.ts` vacuous by leaving them
 *   comparing against an empty second line. Width is measured per line, so a
 *   separator never needs a column. CR is *not* excluded: nothing in this
 *   codebase's output uses it structurally.
 * - **ESC** (0x1B), so that a sequence the grammar above does not recognise
 *   stays visible text rather than silently costing nothing. That recogniser
 *   is the only thing allowed to consume an ESC.
 */
const ZERO_WIDTH_CONTROL_CLASS = String.raw`[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]`;
const ZERO_WIDTH_CONTROLS = new RegExp(ZERO_WIDTH_CONTROL_CLASS, "g");
const ZERO_WIDTH_CONTROL_ONLY = new RegExp(`^${ZERO_WIDTH_CONTROL_CLASS}$`);

/** `str` with every complete escape sequence and zero-width control removed. */
export function stripAnsi(str: string): string {
  return str.replace(ESCAPE_ANYWHERE, "").replace(ZERO_WIDTH_CONTROLS, "");
}

/**
 * Length of the complete escape sequence starting at `index`, or 0 if none is.
 *
 * The seam that keeps `truncateAnsi` measuring the same string the same way
 * `visibleLength` does. It used to carry its own private recogniser — an
 * `indexOf("m")` scan — and the two disagreeing was half of #113: the scan read
 * the `m` of `home` as an SGR terminator and charged three columns of visible
 * text nothing at all.
 */
export function escapeLengthAt(str: string, index: number): number {
  ESCAPE_AT.lastIndex = index;
  const match = ESCAPE_AT.exec(str);
  return match === null ? 0 : match[0].length;
}

/**
 * Whether a grapheme cluster is a control that drives the terminal but draws nothing.
 *
 * Tests against the anchored, non-global copy of the class deliberately.
 * `.test()` on the `g`-flagged one advances its `lastIndex` and would return
 * false on every second call for the same character.
 */
export function isZeroWidthControl(cluster: string): boolean {
  return ZERO_WIDTH_CONTROL_ONLY.test(cluster);
}

/**
 * Terminal columns `str` occupies, ignoring ANSI colour codes.
 *
 * Measures COLUMNS, not characters and not UTF-16 code units. `String.length`
 * counts code units, so a CJK glyph — two columns wide — counted as one, and
 * every width decision built on this (shrink, truncate, compact-fit)
 * under-measured by half and overflowed the terminal. Issue #86.
 *
 * Escapes and zero-width controls cost nothing, per `stripAnsi`. This once
 * removed SGR alone, so an OSC-8 hyperlink from a `custom-command` measured 37
 * columns for the 4 it draws and the bar truncated early to make room for
 * bytes nothing renders. Issue #113.
 */
export function visibleLength(str: string): number {
  return displayWidth(stripAnsi(str));
}
