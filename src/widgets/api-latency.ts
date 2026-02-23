import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";

export const apiLatencyWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const apiMs = context.stdin.cost?.total_api_duration_ms;
    if (apiMs == null || apiMs === 0) return null;

    const label = config.label ?? "API:";
    const text = `${label} ${formatDuration(apiMs)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
