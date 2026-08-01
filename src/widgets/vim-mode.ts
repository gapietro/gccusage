import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { VIM_NORMAL, VIM_INSERT } from "./alert-colors.js";

// In the default layout vim-mode sits directly after today-spend on line 2 —
// retiring api-latency removed the segment that used to separate them. The
// powerline arrow is drawn in the previous segment's bg, so any color shared
// with today-spend's runtime bg makes that arrow invisible. Both of these are
// therefore chosen to differ from every color today-spend can render:
// #26a269 (default), ALERT_AMBER (>= dailyWarn), ALERT_RED (>= dailyDanger).
const MODE_COLORS: Record<string, string> = {
  NORMAL: VIM_NORMAL,  // green, vs today-spend's #26a269
  INSERT: VIM_INSERT,  // amber, vs today-spend's warn ALERT_AMBER
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
