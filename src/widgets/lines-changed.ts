import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export const linesChangedWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const added = context.stdin.cost?.total_lines_added;
    const removed = context.stdin.cost?.total_lines_removed;
    if (added == null && removed == null) return null;

    const a = added ?? 0;
    const r = removed ?? 0;
    if (a === 0 && r === 0) return null;

    const parts: string[] = [];
    if (a > 0) parts.push(`+${a}`);
    if (r > 0) parts.push(`-${r}`);

    const label = config.label ?? "";
    const text = label ? `${label} ${parts.join(" ")}` : parts.join(" ");
    return { text, fg: config.fg, bg: config.bg };
  },
};
