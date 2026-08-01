import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { VIM_NORMAL, VIM_INSERT } from "./alert-colors.js";

// Rationale for these specific colors (adjacency to today-spend on line 2)
// lives in alert-colors.ts, next to the values themselves.
const MODE_COLORS: Record<string, string> = {
  NORMAL: VIM_NORMAL, // green, vs today-spend's #26a269
  INSERT: VIM_INSERT, // amber, vs today-spend's warn ALERT_AMBER
};

export const vimModeWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const mode = context.stdin.vim?.mode;
    if (!mode) return null;

    const label = config.label ?? "";
    const text = label ? `${label} ${mode}` : mode;
    const bg = config.bg ?? MODE_COLORS[mode] ?? MODE_COLORS["NORMAL"];
    return { text, fg: config.fg ?? "#ffffff", bg };
  },
};
