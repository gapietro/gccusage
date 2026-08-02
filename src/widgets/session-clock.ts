import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";

export const sessionClockWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.sessionStartTime) return null;

    const elapsed = Date.now() - context.sessionStartTime;
    // Labelled "Session:" because session-timer renders a different quantity in
    // the same shape (#61). sessionStartTime is the transcript's first
    // timestamp, so this spans the whole logical session and survives
    // --resume; session-timer's cost.total_duration_ms is Date.now() minus the
    // CLI *process* start time (verified against the 2.1.220 binary), which
    // resets on restart. Two bare durations were indistinguishable; the labels
    // are what tell them apart. `label: ""` still opts out.
    const label = config.label ?? "Session:";
    const text = label ? `${label} ${formatDuration(elapsed)}` : formatDuration(elapsed);
    return { text, fg: config.fg, bg: config.bg };
  },
};
