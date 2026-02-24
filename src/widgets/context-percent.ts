import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatPercent, formatTokens } from "../utils/format.js";

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
    const cw = context.stdin.context_window;
    const label = config.label ?? "";
    let ratio: number | null = null;
    let windowSize: number | null = null;

    if (typeof cw === "object" && cw !== null && cw !== undefined) {
      // Claude Code format: { remaining_percentage, used_percentage, context_window_size, current_usage }
      windowSize = cw.context_window_size ?? null;
      if (cw.remaining_percentage != null) {
        // remaining_percentage accounts for all tokens (input, output, system, etc.)
        // Convert to "used" ratio for display
        ratio = (100 - cw.remaining_percentage) / 100;
      } else if (cw.used_percentage != null) {
        ratio = cw.used_percentage / 100;
      } else if (cw.current_usage && windowSize && windowSize > 0) {
        const u = cw.current_usage;
        const total =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        ratio = total / windowSize;
      }
    } else if (typeof cw === "number" && cw > 0) {
      // Legacy format: context_window is a plain number
      windowSize = cw;
      const usage = context.stdin.token_usage;
      if (usage) {
        const total =
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        ratio = total / cw;
      }
    }

    if (ratio === null) return null;

    const bar = buildBar(ratio);
    const pct = formatPercent(ratio);
    const size = windowSize ? ` (${formatTokens(windowSize)})` : "";
    const text = label ? `${label} ${bar} ${pct}${size}` : `${bar} ${pct}${size}`;
    return { text, fg: config.fg, bg: thresholdBg(ratio, config.bg) };
  },
};
