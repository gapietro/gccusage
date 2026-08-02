import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";

/**
 * Session input and output tokens in one segment.
 *
 * Reads `metrics.totals`, the JSONL-derived cumulative totals — the same
 * source `tokens-input` and `tokens-output` read, so the three agree about
 * one session rather than contradicting each other on the same bar (#58).
 *
 * Deliberately NOT `context_window.total_input_tokens` /
 * `total_output_tokens`, which this widget used to read: those are a snapshot
 * of the last assistant message, not session totals. On the captured 2.1.220
 * payload that rendered `In:268.8k Out:536` for a session whose real totals
 * were 396 in and 137.8k out. `compact-countdown` had the identical
 * misreading before PR #38.
 */
export const tokenBreakdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const input = context.metrics.totals.inputTokens;
    const output = context.metrics.totals.outputTokens;
    // Nothing measured yet (no transcript, or a session that has not billed a
    // turn): a breakdown of zero and zero is noise, so decline as before.
    if (input === 0 && output === 0) return null;

    const text = `In:${formatTokens(input)} Out:${formatTokens(output)}`;
    return { text, fg: config.fg, bg: config.bg };
  },
};
