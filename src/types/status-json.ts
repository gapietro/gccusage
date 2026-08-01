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

// Claude Code's `workspace` block also carries `current_dir` (a duplicate of
// top-level `cwd`), `added_dirs[]` and `repo{host,owner,name}`. None has a
// consumer, and valibot strips unrecognised keys, so they stay unparsed until
// one does. `project_dir` is the repo root — the only correct source for a
// project identifier (#59); `cwd` is wherever the shell happened to be.
const WorkspaceSchema = v.object({
  project_dir: v.optional(v.string()),
});

export const StatusJsonSchema = v.object({
  model: v.optional(ModelSchema),
  cost: v.optional(CostSchema),
  context_window: v.optional(ContextWindowSchema),
  token_usage: v.optional(TokenUsageSchema),
  vim: v.optional(VimSchema),
  cwd: v.optional(v.string()),
  workspace: v.optional(WorkspaceSchema),
  session_id: v.optional(v.string()),
});

export type StatusJson = v.InferOutput<typeof StatusJsonSchema>;
