import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatModelName } from "../utils/format.js";

export const modelWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const model = context.stdin.model;
    if (!model) return null;

    const label = config.label ?? "";
    const icon = config.icon ?? "";
    const name = formatModelName(model);
    const prefix = [icon, label].filter(Boolean).join(" ");
    const text = prefix ? `${prefix} ${name}` : name;

    return { text, fg: config.fg, bg: config.bg };
  },
};
