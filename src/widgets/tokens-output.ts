import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";

export const tokensOutputWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const label = config.label ?? "Out:";
    const text = `${label} ${formatTokens(context.metrics.session.outputTokens)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
