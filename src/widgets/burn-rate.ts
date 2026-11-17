import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatCostPerHour } from "../utils/format.js";

export const burnRateWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.burnRate) return null;

    const label = config.label ?? "";
    const costPerHour = context.burnRate.costPerHour;
    // Marked like the session total it is derived from (COR-008). A
    // non-finite rate already renders as "$?/hr"; another "?" would read
    // "$?/hr?", the rate's version of "$??" (#145).
    const marked = context.burnRateUncertain && Number.isFinite(costPerHour);
    const rate = formatCostPerHour(costPerHour) + (marked ? "?" : "");
    const text = label ? `${label} ${rate}` : rate;
    return { text, fg: config.fg, bg: config.bg };
  },
};
