import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

const MODE_COLORS: Record<string, string> = {
  NORMAL: "#26a269",  // green
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
