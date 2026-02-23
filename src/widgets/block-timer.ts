import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatDuration } from "../utils/format.js";

export const blockTimerWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.block) return null;

    const label = config.label ?? "Block:";
    const text = `${label} ${formatDuration(context.block.elapsedMs)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
