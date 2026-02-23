import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export const separatorWidget: Widget = {
  render(_context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const text = config.separator ?? " | ";
    return { text, fg: config.fg, bg: config.bg };
  },
};
