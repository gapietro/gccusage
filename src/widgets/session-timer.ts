import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";

export const sessionTimerWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const durationMs = context.stdin.cost?.total_duration_ms;
    if (!durationMs || durationMs < 1000) return null;

    // "Up:" — this is process uptime, not session age. See session-clock.ts (#61).
    const label = config.label ?? "Up:";
    const text = label ? `${label} ${formatDuration(durationMs)}` : formatDuration(durationMs);
    return { text, fg: config.fg, bg: config.bg };
  },
};
