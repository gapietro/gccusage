export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
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
