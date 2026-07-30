import chalk from "chalk";
import type { WidgetOutput } from "../widgets/base.js";
import { getTheme } from "./themes.js";
import { normalizeColor } from "./color-compare.js";

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
