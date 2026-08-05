import * as v from "valibot";

/**
 * Every field in this payload is optional AND independently recoverable.
 *
 * Claude Code owns this format and evolves it. Parsed as one unit, a single
 * field whose type changed upstream threw, `parseStatusJson` returned null,
 * and the bar rendered a confident `$0.00` — with every other field discarded
 * (#83). `v.fallback` localises that: a field that fails validation becomes
 * undefined and its siblings survive.
 *
 * Applied at every level on purpose, not just to the top-level blocks. A
 * string `used_percentage` should cost the percentage, not the whole
 * `context_window` — which also carries the window size and the data behind
 * the compaction countdown.
 */
function lenient<const S extends v.GenericSchema>(schema: S) {
  return v.fallback(v.optional(schema), undefined);
}

/** Same, for the fields that carry a numeric default rather than undefined. */
function lenientWithDefault<const S extends v.GenericSchema<unknown, number>>(
  schema: S,
  value: number,
) {
  return v.fallback(v.optional(schema, value), value);
}

/**
 * `v.finite()`, never bare `v.number()` — for EVERY number in this payload.
 *
 * JSON has no `Infinity` literal, which made "JSON cannot encode it, so
 * `v.number()` is enough" a tempting and wrong conclusion. An out-of-range
 * numeric literal OVERFLOWS: `JSON.parse('{"x":1e400}').x` is `Infinity`, and
 * both `v.number()` and `typeof x === "number"` accept it.
 *
 * Applied at the boundary rather than in each formatter on purpose. #131
 * closed this for cost by guarding `formatDollars` and `formatCostPerHour`,
 * which left `formatTokens` rendering `InfinityM` for a window size and
 * `formatDuration` rendering `Infinityhr NaNm` — the class was being closed
 * one formatter at a time, and every widget added later re-opened it (#137).
 *
 * Costs only the offending field: every use sits inside `lenient` /
 * `lenientWithDefault`, so a rejected number falls back to undefined or its
 * default and the bar still draws, per the per-field posture of #83.
 */
function finiteNumber() {
  return v.pipe(v.number(), v.finite());
}

const ModelSchema = v.union([
  v.string(),
  v.object({
    id: lenient(v.string()),
    display_name: lenient(v.string()),
  }),
]);

const CostSchema = v.object({
  total_cost_usd: lenient(finiteNumber()),
  total_duration_ms: lenient(finiteNumber()),
  total_api_duration_ms: lenient(finiteNumber()),
  total_lines_added: lenient(finiteNumber()),
  total_lines_removed: lenient(finiteNumber()),
});

const CurrentUsageSchema = v.object({
  input_tokens: lenientWithDefault(finiteNumber(), 0),
  output_tokens: lenientWithDefault(finiteNumber(), 0),
  cache_creation_input_tokens: lenientWithDefault(finiteNumber(), 0),
  cache_read_input_tokens: lenientWithDefault(finiteNumber(), 0),
});

const ContextWindowSchema = v.union([
  // The legacy flat form: a plain token count. `deriveContextUsage` tests it
  // with `typeof cw === "number" && cw > 0`, which `Infinity` passes.
  finiteNumber(),
  v.object({
    context_window_size: lenient(finiteNumber()),
    used_percentage: lenient(v.nullable(finiteNumber())),
    remaining_percentage: lenient(v.nullable(finiteNumber())),
    total_input_tokens: lenient(finiteNumber()),
    total_output_tokens: lenient(finiteNumber()),
    current_usage: lenient(v.nullable(CurrentUsageSchema)),
  }),
]);

// Legacy flat token_usage (for backwards compat with test inputs)
const TokenUsageSchema = v.object({
  input_tokens: lenientWithDefault(finiteNumber(), 0),
  output_tokens: lenientWithDefault(finiteNumber(), 0),
  cache_creation_input_tokens: lenientWithDefault(finiteNumber(), 0),
  cache_read_input_tokens: lenientWithDefault(finiteNumber(), 0),
});

const VimSchema = v.object({
  mode: lenient(v.string()),
});

// Claude Code's `workspace` block also carries `current_dir` (a duplicate of
// top-level `cwd`), `added_dirs[]` and `repo{host,owner,name}`. None has a
// consumer, and valibot strips unrecognised keys, so they stay unparsed until
// one does. `project_dir` is the repo root — the only correct source for a
// project identifier (#59); `cwd` is wherever the shell happened to be.
const WorkspaceSchema = v.object({
  project_dir: lenient(v.string()),
});

export const StatusJsonSchema = v.object({
  model: lenient(ModelSchema),
  cost: lenient(CostSchema),
  context_window: lenient(ContextWindowSchema),
  token_usage: lenient(TokenUsageSchema),
  vim: lenient(VimSchema),
  cwd: lenient(v.string()),
  workspace: lenient(WorkspaceSchema),
  session_id: lenient(v.string()),
});

export type StatusJson = v.InferOutput<typeof StatusJsonSchema>;
