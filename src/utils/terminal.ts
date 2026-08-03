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

/**
 * SGR alone: `ESC [`, digits/`;`/`:`, `m`. Anchored, and deliberately narrower
 * than "a CSI whose final byte is `m`".
 *
 * `ESCAPE_SEQUENCE` spells a CSI's parameter bytes `[0-?]`, per ECMA-48, and
 * that range includes the private markers `< = > ?`. So `ESC[>4;2m` ends in
 * `m` and would pass the obvious check — but it is xterm's `modifyOtherKeys`,
 * which reconfigures how the terminal reports keypresses. Letting a
 * `custom-command` do that is precisely the hazard #115 exists to close.
 *
 * `:` is admitted for T.416 subparameter forms (`38:2::10:20:30`), which real
 * tools emit for truecolour and underline styles. A private marker is excluded
 * outright: the parameter-byte class admits only digits, `;` and `:`, so `<`,
 * `=`, `>` and `?` cannot appear anywhere in it, not merely as the first byte.
 * Intermediate bytes are excluded too: `ESC[ m` is not SGR.
 *
 * This is a second pattern in a module whose whole point is that there is one
 * recogniser. It does not break that rule. `sanitizeAnsi` uses
 * `escapeLengthAt` — and only `escapeLengthAt` — to decide where a sequence
 * starts and ends; this pattern only classifies a span whose boundaries are
 * already fixed. Finding boundaries is the job that must never be duplicated.
 * Keep it anchored so it can only ever test a whole span.
 */
const SGR_ONLY = /^\u001b\[[0-9;:]*m$/;

const RESET = "\u001b[0m";

/**
 * 8-bit C1 control range, U+0080-U+009F. \u009b is CSI and \u009d is OSC in
 * their single-byte forms -- the same sequence classes ESCAPE_SEQUENCE
 * recognises via their 7-bit ESC-prefixed spellings (ESC [ and ESC ]), one
 * byte shorter. VTE-based terminals (GNOME Terminal, Tilix, Terminator) parse
 * C1 controls when reading UTF-8, so a `custom-command` printing \u009b2J
 * erases the screen and \u009d0;pwned retitles the window without ever
 * spelling ESC -- issue #115's exact hazard, walking straight past a
 * recogniser that only ever inspects `\u001b`.
 *
 * `sanitizeAnsi` alone drops these. `ZERO_WIDTH_CONTROL_CLASS` is
 * deliberately NOT widened to cover this range: that constant governs
 * measurement, whose semantics were settled by #113 and #86, and widening it
 * would change what `visibleLength` counts as zero-width for every caller,
 * not just this one.
 */
const C1_CONTROL = /[\u0080-\u009f]/;

/**
 * `str` with every terminal control sequence removed except SGR colour,
 * whether spelled as a 7-bit ESC-prefixed sequence or its 8-bit C1
 * equivalent.
 *
 * The other half of #113. That fix made non-SGR escapes *measure* correctly;
 * measuring them correctly does not stop them reaching the terminal. This
 * statusline is not written to a terminal the tool owns — Claude Code embeds
 * it in its own Ink-rendered TUI — so `ESC[2J`, `ESC[1A`, `ESC[?25l`, `ESC]0;`
 * or a bare `CR` corrupt a rendering this tool has no control over, on a
 * cadence of every render. Issue #115. Reachable through `custom-command`,
 * which puts arbitrary shell output in the bar.
 *
 * **Four rules here invert what the rest of this module does, each on
 * purpose:**
 *
 * - **An incomplete escape is dropped, not kept.** For measuring, a sequence
 *   the grammar cannot complete stays visible text: over-measuring truncates
 *   early, which is cosmetic, while under-measuring overflows the terminal.
 *   For emitting, keeping it is the attack — output ending in an unterminated
 *   `ESC[2` is completed into a screen-clear by the next literal `J` anywhere
 *   later in the bar, and the terminal does not care that the two halves came
 *   from different widgets. Only the ESC byte goes; the printable remainder
 *   stays and renders as literal text.
 * - **LF is dropped, though `stripAnsi` deliberately keeps it.** There, LF is
 *   structural: the bar is two lines and callers `split("\n")`. Here we are one
 *   layer down, on a single segment, before `renderFull` joins lines — so a LF
 *   can only break the bar's line structure from inside a segment.
 * - **TAB becomes one space rather than being dropped.** Its width is not
 *   knowable statically, so `ZERO_WIDTH_CONTROL_CLASS` excludes it and callers
 *   count it as 1 — a floor. One space makes that floor exact, and keeps the
 *   separation the tab was expressing instead of turning `foo⇥bar` into
 *   `foobar`.
 * - **An 8-bit C1 introducer is dropped too, not just the 7-bit ESC form.**
 *   \u009b (CSI) and \u009d (OSC) reach a VTE-based terminal identically to
 *   `ESC [` / `ESC ]` -- see `C1_CONTROL` above. Only the one-byte
 *   introducer goes; the printable remainder is ordinary text, same
 *   failsafe as the stray-ESC rule.
 *
 * **OSC-8 hyperlinks are dropped**, which is the judgment call #115 flags.
 * Keeping them would mean parsing OSC parameters to separate `ESC]8;;uri` from
 * `ESC]0;title` — the allowlist stops being one sequence class and becomes a
 * parameter-level policy — and force-closing every link, since an unclosed one
 * leaks link state onto everything Claude Code draws after the bar. That is
 * real machinery for a capability nobody has asked for, and which only some
 * terminals render inside a statusline. To relax it, widen this one predicate.
 *
 * **A trailing reset is appended when any SGR survives.** `powerline.ts` wraps
 * each segment as `chalk.hex(fg).bgHex(bg)(" " + text + " ")`, and chalk closes
 * only fg (`ESC[39m`) and bg (`ESC[49m`) — never a full reset. So an unclosed
 * `ESC[7m` or `ESC[5m` survives past the segment, past the bar, and into
 * Claude Code's TUI: the same corruption class as `ESC[2J`, arriving through a
 * sequence we agreed to allow. The cost is the segment's trailing padding
 * column losing its background in powerline mode, which is already being paid
 * — a command that colours itself almost always emits its own `ESC[0m`.
 *
 * Text with no visible content collapses to `""`, so `renderer.ts` sees what it
 * already treats as a separator and cleans it away, rather than laying out a
 * bare padded segment with a separator on each side.
 */
export function sanitizeAnsi(str: string): string {
  let out = "";
  let sawSgr = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i]!;

    if (ch === "\u001b") {
      const length = escapeLengthAt(str, i);
      if (length === 0) {
        i += 1; // Stray ESC: drop the byte, keep whatever printable follows.
        continue;
      }
      const sequence = str.slice(i, i + length);
      if (SGR_ONLY.test(sequence)) {
        out += sequence;
        sawSgr = true;
      }
      i += length;
      continue;
    }

    if (C1_CONTROL.test(ch)) {
      i += 1; // 8-bit C1 introducer: drop the byte, keep whatever printable
      continue; // follows -- the same failsafe as the stray-ESC rule above.
    }

    if (ch === "\t") {
      out += " ";
    } else if (ch !== "\n" && !isZeroWidthControl(ch)) {
      out += ch;
    }
    i += 1;
  }

  if (visibleLength(out) === 0) return "";
  if (!sawSgr || out.endsWith(RESET)) return out;
  return out + RESET;
}
