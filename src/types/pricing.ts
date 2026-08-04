export interface RateSet {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number;
  /**
   * Rate for a cache write requesting the 1-hour TTL. Required, not optional:
   * it is always derivable (`input x 2`), so optionality would buy nothing and
   * force a `??` at the cost site. A write's TTL is an independent dimension
   * from the prompt's size, so this appears on the base rates AND on
   * `above200k` (#118).
   */
  cacheCreation1hCostPerToken: number;
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
