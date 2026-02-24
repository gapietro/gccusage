import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export const turnCounterWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const count = context.turnCount;
    if (!count || count < 1) return null;

    const label = config.label ?? "#";
    const text = `${label}${count}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
