/**
 * Anthropic charges a premium on a request whose prompt exceeds 200k tokens.
 * The threshold is PER REQUEST, not per session: 50 turns of 60k each is 3M
 * cumulative input at standard rates. Comparison is strictly greater-than,
 * so a prompt of exactly 200,000 is standard.
 */
export const PREMIUM_PROMPT_THRESHOLD = 200_000;

/** The LiteLLM feed's names for the tier. It encodes the threshold in them. */
export const TIER_FIELDS = {
  input: "input_cost_per_token_above_200k_tokens",
  output: "output_cost_per_token_above_200k_tokens",
  cacheCreation: "cache_creation_input_token_cost_above_200k_tokens",
  cacheRead: "cache_read_input_token_cost_above_200k_tokens",
  cacheCreation1hAbove200k: "cache_creation_input_token_cost_above_1hr_above_200k_tokens",
} as const;

/**
 * The 1-hour cache TTL is a SEPARATE dimension from the 200k prompt tier: this
 * one keys on the TTL the request asked for, that one on the prompt's size.
 * The feed publishes the cross product, which is why TIER_FIELDS carries a
 * 1-hour entry too (#118).
 */
export const CACHE_1H_FIELD = "cache_creation_input_token_cost_above_1hr";

/**
 * A 1-hour cache write costs twice the input rate. Verified against the live
 * feed: 21 of the 23 `claude-*` keys publishing the rate match this exactly,
 * and the 2 that do not are provably-broken records (spec D2). The same factor
 * reproduces all three published cross-product rates.
 */
export const CACHE_1H_INPUT_MULTIPLIER = 2;
