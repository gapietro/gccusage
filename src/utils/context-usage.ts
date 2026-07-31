import type { StatusJson } from "../types/status-json.js";

export interface ContextUsage {
  /** Fraction of the context window consumed, 0..1. */
  ratio: number;
  /** Window size in tokens, or null when stdin did not report one. */
  windowSize: number | null;
  /**
   * Tokens occupying the window: exact when stdin reported the breakdown,
   * otherwise derived from `ratio`, otherwise null.
   *
   * Prefer this over `ratio` for token maths. `used_percentage` is a whole
   * number, which at a 1M window quantises to 10k-token steps — against a
   * 33k-token compaction budget that is up to +/-5k of error.
   */
  usedTokens: number | null;
}

interface TokenCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function sumTokens(counts: TokenCounts): number {
  return (
    (counts.input_tokens ?? 0) +
    (counts.output_tokens ?? 0) +
    (counts.cache_creation_input_tokens ?? 0) +
    (counts.cache_read_input_tokens ?? 0)
  );
}

function withTokens(
  ratio: number,
  windowSize: number | null,
  exact: number | undefined,
): ContextUsage {
  const usedTokens =
    exact ?? (windowSize !== null ? Math.round(ratio * windowSize) : null);
  return { ratio, windowSize, usedTokens };
}

/**
 * How full the context window is.
 *
 * Deliberately ignores `total_input_tokens` / `total_output_tokens`: those are
 * cumulative across the whole session and exceed the window size on any long
 * session. They are correct for rate math (see burn-rate), never for fullness.
 */
export function deriveContextUsage(stdin: StatusJson): ContextUsage | null {
  const cw = stdin.context_window;

  if (typeof cw === "object" && cw !== null) {
    const windowSize = cw.context_window_size ?? null;
    // Exact when present, regardless of which field supplies the ratio.
    const exact = cw.current_usage ? sumTokens(cw.current_usage) : undefined;

    // remaining_percentage accounts for all tokens (input, output, system).
    if (cw.remaining_percentage != null) {
      return withTokens((100 - cw.remaining_percentage) / 100, windowSize, exact);
    }
    if (cw.used_percentage != null) {
      return withTokens(cw.used_percentage / 100, windowSize, exact);
    }
    if (exact !== undefined && windowSize && windowSize > 0) {
      return withTokens(exact / windowSize, windowSize, exact);
    }
    return null;
  }

  // Legacy format: context_window is a plain number of tokens.
  if (typeof cw === "number" && cw > 0) {
    const usage = stdin.token_usage;
    if (!usage) return null;
    const exact = sumTokens(usage);
    return withTokens(exact / cw, cw, exact);
  }

  return null;
}
