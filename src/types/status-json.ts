import * as v from "valibot";

const CostSchema = v.object({
  total_cost_usd: v.optional(v.number()),
});

const TokenUsageSchema = v.object({
  input_tokens: v.optional(v.number(), 0),
  output_tokens: v.optional(v.number(), 0),
  cache_creation_input_tokens: v.optional(v.number(), 0),
  cache_read_input_tokens: v.optional(v.number(), 0),
});

export const StatusJsonSchema = v.object({
  model: v.optional(v.string()),
  cost: v.optional(CostSchema),
  token_usage: v.optional(TokenUsageSchema),
  context_window: v.optional(v.number()),
  cwd: v.optional(v.string()),
  session_id: v.optional(v.string()),
});

export type StatusJson = v.InferOutput<typeof StatusJsonSchema>;
