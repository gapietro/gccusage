import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars } from "../utils/format.js";

function alertBg(cost: number, warn: number, danger: number, configBg?: string): string | undefined {
  if (cost >= danger) return "#c01c28"; // red
  if (cost >= warn) return "#a67c00"; // yellow/amber
  return configBg;
}

export const sessionCostWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cost = context.sessionCostUsd;
    const label = config.label ?? "";
    const text = label ? `${label} ${formatDollars(cost)}` : formatDollars(cost);
    const bg = alertBg(cost, context.alerts.sessionWarn, context.alerts.sessionDanger, config.bg);
    return { text, fg: config.fg, bg };
  },
};
