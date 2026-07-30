import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";

/** Auto-compact fires once this fraction of the context window is consumed. */
const AUTOCOMPACT_THRESHOLD = 1 - 0.165;

const HEADROOM_DANGER = 0.1;
const HEADROOM_WARN = 0.25;

export const compactCountdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    // Without a window size a ratio cannot be turned into a token count.
    if (!usage || !usage.windowSize) return null;

    const threshold = usage.windowSize * AUTOCOMPACT_THRESHOLD;
    const remaining = Math.max(0, Math.round(threshold - usage.ratio * usage.windowSize));

    if (remaining <= 0) {
      return { text: "Compact imminent!", fg: "#ffffff", bg: "#c01c28" };
    }

    const headroom = remaining / threshold;
    let bg = config.bg;
    if (headroom < HEADROOM_DANGER) bg = "#c01c28"; // red
    else if (headroom < HEADROOM_WARN) bg = "#a67c00"; // amber

    return { text: `~${formatTokens(remaining)} left`, fg: config.fg, bg };
  },
};
