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
} as const;
