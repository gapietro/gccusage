import { visibleLength } from "../utils/terminal.js";

export type FlexMode = "left" | "right" | "center" | "space-between";

export function applyFlex(
  segments: string[],
  totalWidth: number | undefined,
  mode: FlexMode,
): string {
  const content = segments.join("");
  // Unknown width: there is nothing to justify against, so emit the content
  // left-aligned regardless of the configured mode.
  if (totalWidth === undefined) return content;
  const contentWidth = visibleLength(content);

  if (contentWidth >= totalWidth) return content;

  const padding = totalWidth - contentWidth;

  switch (mode) {
    case "right":
      return " ".repeat(padding) + content;
    case "center": {
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return " ".repeat(left) + content + " ".repeat(right);
    }
    case "space-between": {
      if (segments.length <= 1) return content + " ".repeat(padding);
      const gaps = segments.length - 1;
      const gapSize = Math.floor(padding / gaps);
      const extra = padding % gaps;
      return segments
        .map((seg, i) => {
          if (i === segments.length - 1) return seg;
          const gap = gapSize + (i < extra ? 1 : 0);
          return seg + " ".repeat(gap);
        })
        .join("");
    }
    case "left":
    default:
      return content + " ".repeat(padding);
  }
}
