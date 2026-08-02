import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";

export const apiLatencyWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const apiMs = context.stdin.cost?.total_api_duration_ms;
    if (apiMs == null || apiMs === 0) return null;

    // total_api_duration_ms is cumulative across every request in the session,
    // not any one request's latency — "API: 35m 5s" read as a request that had
    // been hanging for half an hour (#62). The registry key stays `api-latency`
    // so existing layouts keep working.
    const label = config.label ?? "API total:";
    const text = `${label} ${formatDuration(apiMs)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
