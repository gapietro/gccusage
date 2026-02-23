export interface TokenMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ModelTokenMetrics extends TokenMetrics {
  model: string;
}

export interface AggregatedMetrics {
  byModel: Map<string, TokenMetrics>;
  session: TokenMetrics;
  today: TokenMetrics;
}
