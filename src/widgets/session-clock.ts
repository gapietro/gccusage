import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";

export const sessionClockWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.sessionStartTime) return null;

    const elapsed = Date.now() - context.sessionStartTime;
    const label = config.label ?? "";
    const text = label ? `${label} ${formatDuration(elapsed)}` : formatDuration(elapsed);
    return { text, fg: config.fg, bg: config.bg };
  },
};
