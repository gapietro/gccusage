import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars } from "../utils/format.js";
import { ALERT_AMBER, ALERT_RED } from "./alert-colors.js";

function alertBg(cost: number, warn: number, danger: number, configBg?: string): string | undefined {
  if (cost >= danger) return ALERT_RED;
  if (cost >= warn) return ALERT_AMBER;
  return configBg;
}

export const todaySpendWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cost = context.todayCostUsd;
    const label = config.label ?? "Today:";
    const text = `${label} ${formatDollars(cost)}`;
    const bg = alertBg(cost, context.alerts.dailyWarn, context.alerts.dailyDanger, config.bg);
    return { text, fg: config.fg, bg };
  },
};
