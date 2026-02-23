import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDollars } from "../utils/format.js";

const BUDGET_WARN = 10; // $10 daily warning
const BUDGET_DANGER = 25; // $25 daily danger

function budgetBg(cost: number, configBg?: string): string | undefined {
  if (cost >= BUDGET_DANGER) return "#c01c28"; // red
  if (cost >= BUDGET_WARN) return "#a67c00"; // yellow/amber
  return configBg;
}

export const todaySpendWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cost = context.todayCostUsd;
    const label = config.label ?? "Today:";
    const text = `${label} ${formatDollars(cost)}`;
    return { text, fg: config.fg, bg: budgetBg(cost, config.bg) };
  },
};
