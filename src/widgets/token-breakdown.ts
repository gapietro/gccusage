import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";

export const tokenBreakdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const cw = context.stdin.context_window;
    if (!cw || typeof cw !== "object") return null;

    const input = cw.total_input_tokens ?? 0;
    const output = cw.total_output_tokens ?? 0;
    if (input === 0 && output === 0) return null;

    const text = `In:${formatTokens(input)} Out:${formatTokens(output)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
