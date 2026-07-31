import chalk from "chalk";
import type { WidgetOutput } from "../widgets/base.js";
import { getTheme } from "./themes.js";
import { colorDistance } from "./color-compare.js";
import { resolveColor } from "./colors.js";

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

/**
 * Below this CIEDE2000 distance two backgrounds are too close for the wide
 * glyph — painted in the previous segment's bg — to read against the incoming
 * one. Exact matches (ΔE 0) are the degenerate case. Measured across every
 * adjacent pair reachable in the shipped defaults, the nearest values either
 * side of this are 6.54 and 9.14, so the exact constant is not delicate.
 * See the issue #40 design spec.
 */
export const MIN_SEPARATOR_DELTA = 8;

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
    // Resolve here rather than at paint time so the pieces this function
    // returns carry the colors that will actually be painted — the separator
    // decision below and every test depend on that.
    const fg = resolveColor(output.fg ?? style.fg);
    const bg = resolveColor(output.bg ?? style.bg);

    // The wide separator is painted in the previous segment's bg over this
    // segment's bg, so when those are the same — or merely too close to tell
    // apart — it does not read and the two segments look like one block.
    // Widgets pick their bg from thresholds at render time, so this is
    // reachable in the shipped defaults: context-percent and compact-countdown
    // sit next to each other with alert shades ΔE 4.61 apart. Fall back to the
    // thin separator, drawn in the previous segment's fg. See issues #36, #40.
    // A whitespace-only separatorThin (e.g. " ") is truthy but has no ink, so
    // it merges the segments just like the empty string would — fall back to
    // the wide glyph in that case too. If both separator and separatorThin
    // are blank, there's nothing to draw either way; we draw the (blank)
    // wide one rather than special-casing it further.
    if (prev !== null) {
      pieces.push(
        colorDistance(prev.bg, bg) < MIN_SEPARATOR_DELTA
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
