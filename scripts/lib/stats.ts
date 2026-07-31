export interface Summary {
  n: number;
  min: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * Linear-interpolation percentile. `p` is a fraction in [0, 1].
 * Returns NaN for an empty input rather than throwing, so callers can
 * summarise an empty slice (e.g. a tool nobody called) without branching.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function summarize(values: number[]): Summary {
  const n = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    n,
    min: n === 0 ? Number.NaN : Math.min(...values),
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99),
    max: n === 0 ? Number.NaN : Math.max(...values),
    mean: n === 0 ? Number.NaN : sum / n,
  };
}

/**
 * Per-token cost relative to one uncached input token.
 *
 * Output is 5x input across the entire current Claude lineup (Opus 5
 * $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50), cache
 * writes are 1.25x at the default 5-minute TTL, and cache reads are 0.1x.
 *
 * Ratios rather than dollar prices, deliberately: the result is
 * model-independent and does not go stale when list prices change. The
 * unit is "input-token-equivalents", not dollars.
 */
export const COST_WEIGHTS = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;

export function costEquivalent(u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    u.inputTokens * COST_WEIGHTS.input +
    u.outputTokens * COST_WEIGHTS.output +
    u.cacheCreationTokens * COST_WEIGHTS.cacheWrite +
    u.cacheReadTokens * COST_WEIGHTS.cacheRead
  );
}
