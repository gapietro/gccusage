import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatCostPerHour } from "../utils/format.js";

export const burnRateWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.burnRate) return null;

    const label = config.label ?? "";
    const rate = formatCostPerHour(context.burnRate.costPerHour);
    const text = label ? `${label} ${rate}` : rate;
    return { text, fg: config.fg, bg: config.bg };
  },
};
