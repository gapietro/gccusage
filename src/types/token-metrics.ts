export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  /**
   * The SUBSET of `cacheCreationTokens` written with the 1-hour TTL. 5-minute
   * tokens are the difference. A subset and not a sibling bucket for the same
   * reason `premium` is: every consumer of `cacheCreationTokens` keeps seeing
   * the full count, so no token widget starts under-reporting the day costing
   * gains a dimension (#118).
   *
   * Because `premium` is itself a `TokenCounts`, this composes into the full
   * {5m,1h} x {standard,above-200k} matrix with no special-casing.
   */
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
}

export interface TokenMetrics extends TokenCounts {
  /**
   * The SUBSET of the counts above that was billed above the 200k threshold.
   * Standard tokens are `total - premium`. It is a subset and not a sibling
   * bucket so that every consumer of the four base fields keeps seeing full
   * totals — the token widgets would otherwise start under-reporting the day
   * costing gained a dimension (#103).
   */
  premium?: TokenCounts;
}

export interface ModelTokenMetrics extends TokenMetrics {
  model: string;
}

export interface AggregatedMetrics {
  byModel: Map<string, TokenMetrics>;
  totals: TokenMetrics;
}
