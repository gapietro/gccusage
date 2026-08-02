import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export const cacheHitRateWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cw = context.stdin.context_window;
    if (typeof cw !== "object" || !cw?.current_usage) return null;

    const u = cw.current_usage;
    const reads = u.cache_read_input_tokens ?? 0;
    const creates = u.cache_creation_input_tokens ?? 0;
    const total = reads + creates;
    if (total === 0) return null;

    const hitRate = Math.round((reads / total) * 100);
    // "Hit:", not "Cache:" — tokens-cached renders an absolute cached-token
    // count under its own label, and both reading "Cache:" made two adjacent
    // segments indistinguishable (#60).
    const label = config.label ?? "Hit:";
    const text = `${label} ${hitRate}%`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
