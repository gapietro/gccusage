import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars } from "../utils/format.js";

export const todaySpendWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const label = config.label ?? "Today:";
    const text = `${label} ${formatDollars(context.todayCostUsd)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
