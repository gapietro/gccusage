import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars } from "../utils/format.js";
import { alertBg } from "./alert-colors.js";

export const todaySpendWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cost = context.todayCostUsd;
    const label = config.label ?? "Today:";
    const text = `${label} ${formatDollars(cost)}${context.todayCostUncertain ? "?" : ""}`;
    const bg = alertBg(cost, context.alerts.dailyWarn, context.alerts.dailyDanger, config.bg);
    return { text, fg: config.fg, bg };
  },
};
