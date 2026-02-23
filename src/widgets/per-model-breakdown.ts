import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars, formatModelName } from "../utils/format.js";

export const perModelBreakdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (context.costByModel.size === 0) return null;

    const parts: string[] = [];
    for (const [model, cost] of context.costByModel) {
      // Short model name: Sonnet 4 -> S4, Opus 4 -> O4
      const name = formatModelName(model);
      const short = name
        .split(" ")
        .map((w) => w[0])
        .join("");
      parts.push(`${short}:${formatDollars(cost)}`);
    }

    const text = parts.join(" ");
    return { text, fg: config.fg, bg: config.bg };
  },
};
