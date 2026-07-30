import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

const MODE_COLORS: Record<string, string> = {
  // Distinct from today-spend's default #26a269: in the default layout
  // vim-mode sits directly after today-spend on line 2 (no separator
  // between them once api-latency was retired), so an identical NORMAL
  // color made the powerline arrow between them invisible.
  NORMAL: "#2ec27e",  // green
  INSERT: "#a67c00",  // amber
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
