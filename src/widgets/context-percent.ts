import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatPercent, formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";

const BAR_WIDTH = 10;
const THRESHOLD_WARN = 0.7;
const THRESHOLD_DANGER = 0.9;

function buildBar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "[" + "=".repeat(filled) + "-".repeat(empty) + "]";
}

function thresholdBg(ratio: number, configBg?: string): string | undefined {
  if (ratio >= THRESHOLD_DANGER) return "#c01c28"; // red
  if (ratio >= THRESHOLD_WARN) return "#a67c00"; // yellow
  return configBg; // default
}

export const contextPercentWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    if (!usage) return null;

    const label = config.label ?? "";
    const bar = buildBar(usage.ratio);
    const pct = formatPercent(usage.ratio);
    const size = usage.windowSize ? ` (${formatTokens(usage.windowSize)})` : "";
    const text = label ? `${label} ${bar} ${pct}${size}` : `${bar} ${pct}${size}`;
    return { text, fg: config.fg, bg: thresholdBg(usage.ratio, config.bg) };
  },
};
