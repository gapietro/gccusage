import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";
import { tokensUntilCompact, alertLevel } from "../utils/autocompact.js";
import { COMPACT_COUNTDOWN_AMBER, COMPACT_COUNTDOWN_RED } from "./alert-colors.js";

export const compactCountdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    // Without a window size a ratio cannot be turned into a token count.
    if (!usage || !usage.windowSize || usage.usedTokens === null) return null;

    const remaining = tokensUntilCompact(usage.usedTokens, usage.windowSize);
    if (remaining === null) return null;

    if (remaining <= 0) {
      return { text: "Compact imminent!", fg: "#ffffff", bg: COMPACT_COUNTDOWN_RED };
    }

    // Bands widen to the resolution of usedTokens so red stays reachable when
    // the count came from a rounded percentage (#46).
    const level = alertLevel(remaining, usage.usedTokensStep);
    let bg = config.bg;
    if (level === "red") bg = COMPACT_COUNTDOWN_RED; // distinct from context-percent's ALERT_RED
    else if (level === "amber") bg = COMPACT_COUNTDOWN_AMBER; // distinct from context-percent's ALERT_AMBER

    return { text: `~${formatTokens(remaining)} left`, fg: config.fg, bg };
  },
};
