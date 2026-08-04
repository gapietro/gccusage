export interface RateSet {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number;
  cacheReadCostPerToken: number;
}

export interface ModelPricing extends RateSet {
  /**
   * Rates for a request whose prompt exceeds PREMIUM_PROMPT_THRESHOLD.
   * Absent when the feed publishes no long-context tier for the model, which
   * is the normal case for a 200k-context model and the current case for
   * `claude-opus-5` (#103).
   */
  above200k?: RateSet;
}

export type PricingTable = Record<string, ModelPricing>;
