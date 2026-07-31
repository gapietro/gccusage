import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatPercent, formatTokens } from "../utils/format.js";
import type { ContextUsage } from "../utils/context-usage.js";
import { deriveContextUsage } from "../utils/context-usage.js";
import { tokensUntilCompact, AMBER_TOKENS, RED_TOKENS } from "../utils/autocompact.js";

const BAR_WIDTH = 10;
const THRESHOLD_WARN = 0.7;
const THRESHOLD_DANGER = 0.9;

function buildBar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "[" + "=".repeat(filled) + "-".repeat(empty) + "]";
}

/**
 * Alert colour.
 *
 * Measured against the auto-compact point rather than raw fullness, so this
 * segment and compact-countdown change on the same turn at any window size.
 * The percentage thresholds remain for payloads that report no window size.
 */
function thresholdBg(usage: ContextUsage, configBg?: string): string | undefined {
  const remaining =
    usage.usedTokens !== null && usage.windowSize !== null
      ? tokensUntilCompact(usage.usedTokens, usage.windowSize)
      : null;

  if (remaining !== null) {
    if (remaining <= RED_TOKENS) return "#c01c28"; // red
    if (remaining <= AMBER_TOKENS) return "#a67c00"; // yellow
    return configBg;
  }

  if (usage.ratio >= THRESHOLD_DANGER) return "#c01c28"; // red
  if (usage.ratio >= THRESHOLD_WARN) return "#a67c00"; // yellow
  return configBg;
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
    return { text, fg: config.fg, bg: thresholdBg(usage, config.bg) };
  },
};
