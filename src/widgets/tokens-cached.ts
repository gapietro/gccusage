import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";

export const tokensCachedWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cached =
      context.metrics.session.cacheCreationTokens +
      context.metrics.session.cacheReadTokens;
    const label = config.label ?? "Cache:";
    const text = `${label} ${formatTokens(cached)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
