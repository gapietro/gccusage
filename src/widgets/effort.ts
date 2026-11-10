import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { EFFORT_COLORS, EFFORT_FALLBACK } from "./alert-colors.js";

// Claude Code's reasoning-effort level (#139). Absent for models without
// effort support, in which case the segment declines and the bar closes up.
// Colour rationale and the distinctness constraint live in alert-colors.ts.
export const effortWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const level = context.stdin.effort?.level?.trim();
    if (!level) return null;

    const label = config.label ?? "";
    const icon = config.icon ?? "";
    const prefix = [icon, label].filter(Boolean).join(" ");
    const text = prefix ? `${prefix} ${level}` : level;
    const bg = config.bg ?? EFFORT_COLORS.get(level) ?? EFFORT_FALLBACK;
    return { text, fg: config.fg ?? "#ffffff", bg };
  },
};
