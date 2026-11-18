import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";
import { ageSince } from "../utils/schemas.js";

export const sessionClockWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.sessionStartTime) return null;

    // A start in the future (a clock set backwards) has no trustworthy age.
    // Raw, it rendered "0s" for a start 1h ahead and "-38s" for 9e15. NaN
    // makes `formatDuration` render "?", the unknown-duration marker
    // block-timer uses, rather than hiding a session that does exist (COR-006).
    const elapsed = ageSince(context.sessionStartTime) ?? Number.NaN;
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
