import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";
import { tokensUntilCompact, AMBER_TOKENS, RED_TOKENS } from "../utils/autocompact.js";

export const compactCountdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    // Without a window size a ratio cannot be turned into a token count.
    if (!usage || !usage.windowSize || usage.usedTokens === null) return null;

    const remaining = tokensUntilCompact(usage.usedTokens, usage.windowSize);
    if (remaining === null) return null;

    if (remaining <= 0) {
      return { text: "Compact imminent!", fg: "#ffffff", bg: "#a01822" };
    }

    let bg = config.bg;
    if (remaining <= RED_TOKENS) bg = "#a01822"; // red (distinct from context-percent's #c01c28)
    else if (remaining <= AMBER_TOKENS) bg = "#b8860b"; // amber (distinct from context-percent's #a67c00)

    return { text: `~${formatTokens(remaining)} left`, fg: config.fg, bg };
  },
};
