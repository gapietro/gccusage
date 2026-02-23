import chalk from "chalk";
import type { WidgetOutput } from "../widgets/base.js";
import { getTheme, type SegmentStyle } from "./themes.js";

// Force truecolor output — chalk disables colors when stdout is a pipe,
// but statusline output is rendered by Claude Code which supports ANSI.
chalk.level = 3;

export interface PowerlineOptions {
  theme: string;
  separator: string;
  separatorThin: string;
}

export function renderPowerlineSegments(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): string {
  const theme = getTheme(options.theme);
  const segments: string[] = [];
  let prevBg: string | null = null;

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i]!;
    const style = theme.segments[i % theme.segments.length]!;
    const fg = output.fg ?? style.fg;
    const bg = output.bg ?? style.bg;

    // Separator from previous segment
    if (prevBg !== null) {
      segments.push(chalk.hex(prevBg).bgHex(bg)(options.separator));
    }

    // Segment content
    segments.push(chalk.hex(fg).bgHex(bg)(` ${output.text} `));
    prevBg = bg;
  }

  // Closing separator
  if (prevBg !== null) {
    segments.push(chalk.hex(prevBg)(options.separator));
  }

  return segments.join("");
}
