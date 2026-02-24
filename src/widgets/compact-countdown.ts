import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";

const AUTOCOMPACT_BUFFER = 0.165; // 16.5% buffer before auto-compact triggers

export const compactCountdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cw = context.stdin.context_window;
    if (!cw || typeof cw !== "object") return null;

    const windowSize = cw.context_window_size;
    if (!windowSize) return null;

    // Calculate used tokens
    const totalInput = cw.total_input_tokens ?? 0;
    const totalOutput = cw.total_output_tokens ?? 0;
    const usedTokens = totalInput + totalOutput;
    if (usedTokens === 0) return null;

    // Auto-compact triggers at (1 - buffer) of context window
    const compactThreshold = windowSize * (1 - AUTOCOMPACT_BUFFER);
    const remaining = Math.max(0, compactThreshold - usedTokens);

    if (remaining <= 0) {
      return { text: "Compact imminent!", fg: "#ffffff", bg: "#c01c28" };
    }

    // Color code based on proximity
    const ratio = remaining / compactThreshold;
    let bg = config.bg;
    if (ratio < 0.1) bg = "#c01c28"; // red: <10% left
    else if (ratio < 0.25) bg = "#a67c00"; // amber: <25% left

    const text = `~${formatTokens(remaining)} left`;
    return { text, fg: config.fg, bg };
  },
};
