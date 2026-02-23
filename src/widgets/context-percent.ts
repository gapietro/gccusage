import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatPercent } from "../utils/format.js";

export const contextPercentWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = context.stdin.token_usage;
    const window = context.stdin.context_window;
    if (!usage || !window || window === 0) return null;

    const totalUsed =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    const ratio = totalUsed / window;

    const label = config.label ?? "";
    const text = label ? `${label} ${formatPercent(ratio)}` : formatPercent(ratio);
    return { text, fg: config.fg, bg: config.bg };
  },
};
