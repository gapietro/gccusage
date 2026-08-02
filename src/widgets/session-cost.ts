import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars } from "../utils/format.js";
import { alertBg } from "./alert-colors.js";

export const sessionCostWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cost = context.sessionCostUsd;
    const label = config.label ?? "";
    // The partial sum is kept and flagged rather than replaced: a session with
    // one unpriced minor model still has a mostly-correct total worth showing.
    const amount = formatDollars(cost) + (context.sessionCostUncertain ? "?" : "");
    const text = label ? `${label} ${amount}` : amount;
    const bg = alertBg(cost, context.alerts.sessionWarn, context.alerts.sessionDanger, config.bg);
    return { text, fg: config.fg, bg };
  },
};
