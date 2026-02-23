import * as v from "valibot";

const ModelSchema = v.union([
  v.string(),
  v.object({
    id: v.optional(v.string()),
    display_name: v.optional(v.string()),
  }),
]);

const CostSchema = v.object({
  total_cost_usd: v.optional(v.number()),
  total_duration_ms: v.optional(v.number()),
  total_api_duration_ms: v.optional(v.number()),
  total_lines_added: v.optional(v.number()),
  total_lines_removed: v.optional(v.number()),
});

const CurrentUsageSchema = v.object({
  input_tokens: v.optional(v.number(), 0),
  output_tokens: v.optional(v.number(), 0),
  cache_creation_input_tokens: v.optional(v.number(), 0),
  cache_read_input_tokens: v.optional(v.number(), 0),
});

const ContextWindowSchema = v.union([
  v.number(),
  v.object({
    context_window_size: v.optional(v.number()),
    used_percentage: v.optional(v.nullable(v.number())),
    remaining_percentage: v.optional(v.nullable(v.number())),
    total_input_tokens: v.optional(v.number()),
    total_output_tokens: v.optional(v.number()),
    current_usage: v.optional(v.nullable(CurrentUsageSchema)),
  }),
]);

// Legacy flat token_usage (for backwards compat with test inputs)
const TokenUsageSchema = v.object({
  input_tokens: v.optional(v.number(), 0),
  output_tokens: v.optional(v.number(), 0),
  cache_creation_input_tokens: v.optional(v.number(), 0),
  cache_read_input_tokens: v.optional(v.number(), 0),
});

const VimSchema = v.object({
  mode: v.optional(v.string()),
});

export const StatusJsonSchema = v.object({
  model: v.optional(ModelSchema),
  cost: v.optional(CostSchema),
  context_window: v.optional(ContextWindowSchema),
  token_usage: v.optional(TokenUsageSchema),
  vim: v.optional(VimSchema),
  cwd: v.optional(v.string()),
  session_id: v.optional(v.string()),
});

export type StatusJson = v.InferOutput<typeof StatusJsonSchema>;
