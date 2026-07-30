import type { StatusJson } from "../types/status-json.js";

export interface ContextUsage {
  /** Fraction of the context window consumed, 0..1. */
  ratio: number;
  /** Window size in tokens, or null when stdin did not report one. */
  windowSize: number | null;
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

    // remaining_percentage accounts for all tokens (input, output, system).
    if (cw.remaining_percentage != null) {
      return { ratio: (100 - cw.remaining_percentage) / 100, windowSize };
    }
    if (cw.used_percentage != null) {
      return { ratio: cw.used_percentage / 100, windowSize };
    }
    if (cw.current_usage && windowSize && windowSize > 0) {
      return { ratio: sumTokens(cw.current_usage) / windowSize, windowSize };
    }
    return null;
  }

  // Legacy format: context_window is a plain number of tokens.
  if (typeof cw === "number" && cw > 0) {
    const usage = stdin.token_usage;
    if (!usage) return null;
    return { ratio: sumTokens(usage) / cw, windowSize: cw };
  }

  return null;
}
