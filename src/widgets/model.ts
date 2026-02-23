import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatModelName } from "../utils/format.js";

export const modelWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const raw = context.stdin.model;
    if (!raw) return null;

    let name: string;
    if (typeof raw === "string") {
      name = formatModelName(raw);
    } else {
      // Claude Code sends { id, display_name }
      name = raw.id ? formatModelName(raw.id) : (raw.display_name ?? "");
    }
    if (!name) return null;

    const label = config.label ?? "";
    const icon = config.icon ?? "";
    const prefix = [icon, label].filter(Boolean).join(" ");
    const text = prefix ? `${prefix} ${name}` : name;

    return { text, fg: config.fg, bg: config.bg };
  },
};
