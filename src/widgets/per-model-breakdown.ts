import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars, formatModelName } from "../utils/format.js";

export const perModelBreakdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (context.costByModel.size === 0) return null;

    const parts: string[] = [];
    for (const [model, cost] of context.costByModel) {
      // Model names render in full. The old abbreviation took the first letter
      // of each space-separated word, which dropped the minor version and
      // collapsed "Sonnet 4.5" and "Sonnet 4" to the same "S4" — two segments
      // labelled identically in the one widget whose entire job is telling
      // models apart (#63). Nothing is shortened now, so nothing can collide.
      parts.push(`${formatModelName(model)}:${formatDollars(cost)}`);
    }

    const text = parts.join(" ");
    return { text, fg: config.fg, bg: config.bg };
  },
};
