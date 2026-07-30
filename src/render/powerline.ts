import chalk from "chalk";
import type { WidgetOutput } from "../widgets/base.js";
import { getTheme } from "./themes.js";

// Force truecolor output — chalk disables colors when stdout is a pipe,
// but statusline output is rendered by Claude Code which supports ANSI.
chalk.level = 3;

export interface PowerlineOptions {
  theme: string;
  separator: string;
  separatorThin: string;
}

/** A styled run of text. `bg` is absent only for the closing separator. */
export interface PowerlinePiece {
  text: string;
  fg: string;
  bg?: string;
}

// Mirrors chalk's own `hexToRgb`, which is deliberately *unanchored* — it
// scans the string for the first 6-run (preferred) or 3-run of hex digits
// anywhere inside it, rather than requiring the whole string to be a clean
// hex color. See node_modules/chalk/source/vendor/ansi-styles/index.js:136
// (chalk@5.6.2): `/[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16))`. Re-check
// this against that file if chalk is ever upgraded.
const CHALK_HEX = /[a-f\d]{6}|[a-f\d]{3}/i;

/**
 * Normalize a color string the way chalk's `hex()`/`bgHex()` actually resolve
 * it: find the first embedded 6-digit (or 3-digit) hex run per chalk's own
 * unanchored regex, expand a 3-digit match to 6, lowercase it, and collapse
 * anything with no such run (named colors, empty strings, garbage) to the
 * same black chalk paints for those inputs. Because the match is unanchored,
 * inputs like "#abcd" or "#12345" resolve to a real color ("#aabbcc",
 * "#112233") rather than black — that mirrors chalk exactly, even though it
 * looks surprising next to the old anchored behavior. Exported so tests can
 * assert visibility through the same lens the renderer uses to compare
 * colors.
 */
export function normalizeColor(color: string): string {
  const match = CHALK_HEX.exec(color);
  if (!match) return "#000000";
  let digits = match[0].toLowerCase();
  if (digits.length === 3) {
    digits = [...digits].map((c) => c + c).join("");
  }
  return `#${digits}`;
}

function sameColor(a: string, b: string): boolean {
  return normalizeColor(a) === normalizeColor(b);
}

/**
 * Resolve widget outputs and the theme into the exact pieces the statusline is
 * painted from. Exported so tests can assert on the real color model rather
 * than re-deriving theme indexing, which would drift out of sync.
 */
export function layoutPowerline(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): PowerlinePiece[] {
  const theme = getTheme(options.theme);
  const pieces: PowerlinePiece[] = [];
  let prev: { fg: string; bg: string } | null = null;

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i]!;
    const style = theme.segments[i % theme.segments.length]!;
    const fg = output.fg ?? style.fg;
    const bg = output.bg ?? style.bg;

    // The wide separator is painted in the previous segment's bg over this
    // segment's bg, so when those match it is invisible and the two segments
    // read as one block. Widgets pick their bg from thresholds at render time,
    // so this is reachable in the shipped defaults — session-cost and
    // context-percent are adjacent and share an alert palette. Fall back to
    // the thin separator, drawn in the previous segment's fg. See issue #36.
    // A whitespace-only separatorThin (e.g. " ") is truthy but has no ink, so
    // it merges the segments just like the empty string would — fall back to
    // the wide glyph in that case too. If both separator and separatorThin
    // are blank, there's nothing to draw either way; we draw the (blank)
    // wide one rather than special-casing it further.
    if (prev !== null) {
      pieces.push(
        sameColor(prev.bg, bg)
          ? {
              text: options.separatorThin.trim() ? options.separatorThin : options.separator,
              fg: prev.fg,
              bg,
            }
          : { text: options.separator, fg: prev.bg, bg },
      );
    }

    pieces.push({ text: ` ${output.text} `, fg, bg });
    prev = { fg, bg };
  }

  // Closing separator: painted on the terminal's own background.
  if (prev !== null) {
    pieces.push({ text: options.separator, fg: prev.bg });
  }

  return pieces;
}

export function renderPowerlineSegments(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): string {
  return layoutPowerline(outputs, options)
    .map((piece) =>
      piece.bg
        ? chalk.hex(piece.fg).bgHex(piece.bg)(piece.text)
        : chalk.hex(piece.fg)(piece.text),
    )
    .join("");
}
