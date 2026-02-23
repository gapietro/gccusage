import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatPercent } from "../utils/format.js";

export const contextPercentWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cw = context.stdin.context_window;
    const label = config.label ?? "";
    let ratio: number | null = null;

    if (typeof cw === "object" && cw !== null && cw !== undefined) {
      // Claude Code format: { used_percentage, context_window_size, current_usage }
      if (cw.used_percentage != null) {
        ratio = cw.used_percentage / 100;
      } else if (cw.current_usage && cw.context_window_size && cw.context_window_size > 0) {
        const u = cw.current_usage;
        const total =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        ratio = total / cw.context_window_size;
      }
    } else if (typeof cw === "number" && cw > 0) {
      // Legacy format: context_window is a plain number
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

    const text = label ? `${label} ${formatPercent(ratio)}` : formatPercent(ratio);
    return { text, fg: config.fg, bg: config.bg };
  },
};
