# Tiered (above-200k) Context Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price requests whose prompt exceeds 200k tokens at the premium rates the LiteLLM feed already publishes, and flag the cost as approximate when a model has premium-band usage but no published premium rate.

**Architecture:** `ModelPricing` gains an optional `above200k` rate set parsed from the feed's `*_above_200k_tokens` fields. `aggregateTokens` splits each JSONL entry into a `premium` **subset** of its counts when that entry's prompt exceeded the threshold — per request, because Anthropic bills the tier per request, not per session. `calculateCost` charges `total − premium` at base rates and `premium` at tier rates. A model with premium tokens and no tier is reported as `approximated`, which drives the bar's existing `?`.

**Tech Stack:** TypeScript, vitest, valibot, tsdown.

**Spec:** `docs/superpowers/specs/2026-08-03-tiered-context-pricing-design.md`
**Issue:** #103

## Global Constraints

- **Every commit touching `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`.** `dist/index.js` is gitignored but force-tracked, and `gccusage setup` points `statusLine.command` at it, so a src-only commit ships nothing to `git pull` upgraders. CI's `bundle-drift` job fails on byte-inequality.
- Imports inside `src/` use `.js` specifiers (tsdown rewrites them). Never `.ts`.
- `PREMIUM_PROMPT_THRESHOLD` is `200_000`, and the comparison is **strictly greater than** — a prompt of exactly 200,000 is standard.
- Prompt size for tier selection is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of a single entry.
- The base four fields of `TokenMetrics` always hold **full** totals. `premium` is a subset of them, never a sibling bucket. Any change that makes the base fields hold standard-only counts is wrong — it silently breaks `tokens-input`, `tokens-output`, `tokens-cached`, `token-breakdown` and `per-model`.
- Never invent a premium rate for a model the feed does not publish one for. Flag it instead.
- Verify every new test by breaking what it guards before committing (repo rule: `vacuous-tests`).
- Full check before each commit: `npm test && npm run typecheck`.

---

### Task 1: Tier rates in the pricing type and the feed parser

**Files:**
- Modify: `src/types/pricing.ts`
- Create: `src/data/pricing-tiers.ts`
- Modify: `src/data/pricing-fetcher.ts` (`parseLitellmPricing`)
- Test: `src/__tests__/pricing-fetcher.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface RateSet { inputCostPerToken: number; outputCostPerToken: number; cacheCreationCostPerToken: number; cacheReadCostPerToken: number }`
  - `interface ModelPricing extends RateSet { above200k?: RateSet }`
  - `const PREMIUM_PROMPT_THRESHOLD = 200_000`
  - `const TIER_FIELDS: { input: string; output: string; cacheCreation: string; cacheRead: string }`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/pricing-fetcher.test.ts`:

```ts
describe("parseLitellmPricing above-200k tier (#103)", () => {
  it("reads the published premium rates into above200k", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003,
        input_cost_per_token_above_200k_tokens: 0.000006,
        output_cost_per_token_above_200k_tokens: 0.0000225,
        cache_creation_input_token_cost_above_200k_tokens: 0.0000075,
        cache_read_input_token_cost_above_200k_tokens: 0.0000006,
      },
    });

    expect(table["claude-sonnet-4-5"]!.above200k).toEqual({
      inputCostPerToken: 0.000006,
      outputCostPerToken: 0.0000225,
      cacheCreationCostPerToken: 0.0000075,
      cacheReadCostPerToken: 0.0000006,
    });
    // The base rates must be untouched by the tier.
    expect(table["claude-sonnet-4-5"]!.inputCostPerToken).toBe(0.000003);
  });

  it("leaves above200k absent when the feed publishes no tier", () => {
    const table = parseLitellmPricing({
      "claude-opus-5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_creation_input_token_cost: 0.00000625,
        cache_read_input_token_cost: 0.0000005,
      },
    });

    expect(table["claude-opus-5"]).toBeDefined();
    expect(table["claude-opus-5"]!.above200k).toBeUndefined();
  });

  it("requires both premium input and output before attaching a tier", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        input_cost_per_token_above_200k_tokens: 0.000006,
        // no output premium
      },
    });

    expect(table["claude-sonnet-4-5"]!.above200k).toBeUndefined();
  });

  it("derives missing premium cache rates off the premium input rate", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        input_cost_per_token_above_200k_tokens: 0.000006,
        output_cost_per_token_above_200k_tokens: 0.0000225,
      },
    });

    const tier = table["claude-sonnet-4-5"]!.above200k!;
    expect(tier.cacheCreationCostPerToken).toBeCloseTo(0.000006 * 1.25, 12);
    expect(tier.cacheReadCostPerToken).toBeCloseTo(0.000006 * 0.1, 12);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/pricing-fetcher.test.ts -t "above-200k"`
Expected: FAIL — `above200k` is `undefined` in the first test (the property does not exist yet).

- [ ] **Step 3: Add the type**

Replace the contents of `src/types/pricing.ts` with:

```ts
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
```

- [ ] **Step 4: Create the tier constants**

Create `src/data/pricing-tiers.ts`:

```ts
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
```

- [ ] **Step 5: Parse the tier**

In `src/data/pricing-fetcher.ts`, add the import and the helper, then attach the tier.

Add to the imports at the top:

```ts
import { TIER_FIELDS } from "./pricing-tiers.js";
import type { RateSet } from "../types/pricing.js";
```

Add above `parseLitellmPricing`:

```ts
/**
 * The feed publishes the long-context tier as four sibling fields rather than
 * a nested object. Both premium input and output must be present before a
 * tier is attached: a half-published tier would charge premium input against
 * standard output and read as authoritative. Missing premium cache rates
 * derive off the PREMIUM input rate exactly as the base ones derive off the
 * base input rate.
 */
function parseTier(model: Record<string, unknown>): RateSet | null {
  const input = model[TIER_FIELDS.input];
  const output = model[TIER_FIELDS.output];
  if (typeof input !== "number" || typeof output !== "number") return null;

  const cacheCreation = model[TIER_FIELDS.cacheCreation];
  const cacheRead = model[TIER_FIELDS.cacheRead];
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreationCostPerToken: typeof cacheCreation === "number" ? cacheCreation : input * 1.25,
    cacheReadCostPerToken: typeof cacheRead === "number" ? cacheRead : input * 0.1,
  };
}
```

In `parseLitellmPricing`, immediately after the `const pricing: ModelPricing = { ... }` literal and **before** the `isSaneModelPricing` check, add:

```ts
    const tier = parseTier(model);
    if (tier) pricing.above200k = tier;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/pricing-fetcher.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 7: Prove the tests are not vacuous**

Temporarily change `parseTier` to `return null;` at the top. Run the tests again — the first and fourth must FAIL. Revert the change.

- [ ] **Step 8: Full check and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/types/pricing.ts src/data/pricing-tiers.ts src/data/pricing-fetcher.ts src/__tests__/pricing-fetcher.test.ts
git add -f dist/index.js
git commit -m "Parse the feed's above-200k tier into ModelPricing (#103)"
```

---

### Task 2: Bound and anchor the tier

**Files:**
- Modify: `src/data/pricing-validation.ts`
- Modify: `src/data/pricing-fetcher.ts` (`parseLitellmPricing` uses the new sanitiser)
- Modify: `src/cache/pricing-cache.ts` — no code change expected; verify `sanitisePricingTable` still compiles against the new return type
- Test: `src/__tests__/pricing-validation.test.ts`, `src/__tests__/cache-validation.test.ts`

**Interfaces:**
- Consumes: `ModelPricing.above200k`, `RateSet` (Task 1).
- Produces: `sanitiseModelPricing(value: unknown): ModelPricing | null` — returns `null` when the base rates fail, and returns the model **with `above200k` removed** when only the tier fails.

**Why the tier is stripped rather than the model dropped:** the same function validates cache reads (`sanitisePricingTable` → `loadPricingCacheEntry`) as validates fetches. Dropping a whole model over a bad premium regresses #92's per-entry posture; falling back to standard rates plus the approximate flag (Task 4) is the honest degradation.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/pricing-validation.test.ts`:

```ts
describe("sanitiseModelPricing tier bounds (#103)", () => {
  const base = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  };

  it("keeps a plausible tier", () => {
    const value = {
      ...base,
      above200k: {
        inputCostPerToken: 0.000006,
        outputCostPerToken: 0.0000225,
        cacheCreationCostPerToken: 0.0000075,
        cacheReadCostPerToken: 0.0000006,
      },
    };
    expect(sanitiseModelPricing(value)?.above200k).toEqual(value.above200k);
  });

  it("strips a tier priced below its standard counterpart, keeping the model", () => {
    const result = sanitiseModelPricing({
      ...base,
      above200k: { ...base, inputCostPerToken: 0.0000001 },
    });

    expect(result).not.toBeNull();
    expect(result!.inputCostPerToken).toBe(base.inputCostPerToken);
    expect(result!.above200k).toBeUndefined();
  });

  it("strips a tier above MAX_COST_PER_TOKEN, keeping the model", () => {
    const result = sanitiseModelPricing({
      ...base,
      above200k: { ...base, outputCostPerToken: MAX_COST_PER_TOKEN * 2 },
    });

    expect(result).not.toBeNull();
    expect(result!.above200k).toBeUndefined();
  });

  it("still drops the model when the base rates fail", () => {
    expect(sanitiseModelPricing({ ...base, inputCostPerToken: 0 })).toBeNull();
  });

  it("passes a model through untouched when it has no tier", () => {
    expect(sanitiseModelPricing(base)).toEqual(base);
  });
});

describe("anchorToSnapshot tier anchoring (#103)", () => {
  const known = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
    above200k: {
      inputCostPerToken: 0.000006,
      outputCostPerToken: 0.0000225,
      cacheCreationCostPerToken: 0.0000075,
      cacheReadCostPerToken: 0.0000006,
    },
  };
  const snapshot = { "claude-sonnet-4-5": known };

  it("accepts a tier within the deviation bound", () => {
    const fetched = {
      "claude-sonnet-4-5": {
        ...known,
        above200k: { ...known.above200k, inputCostPerToken: 0.0000066 },
      },
    };
    expect(anchorToSnapshot(fetched, snapshot)["claude-sonnet-4-5"]).toBeDefined();
  });

  it("rejects a model whose tier drifted beyond the deviation bound", () => {
    const fetched = {
      "claude-sonnet-4-5": {
        ...known,
        above200k: { ...known.above200k, inputCostPerToken: 0.000006 * 20 },
      },
    };
    expect(anchorToSnapshot(fetched, snapshot)["claude-sonnet-4-5"]).toBeUndefined();
  });

  it("accepts a newly published tier the snapshot has no counterpart for", () => {
    const snapshotWithoutTier = { "claude-opus-5": { ...known, above200k: undefined } };
    const fetched = { "claude-opus-5": known };
    expect(anchorToSnapshot(fetched, snapshotWithoutTier)["claude-opus-5"]?.above200k).toBeDefined();
  });
});
```

Extend the import at the top of that file to include `sanitiseModelPricing` and `MAX_COST_PER_TOKEN` if they are not already imported.

Then append to `src/__tests__/cache-validation.test.ts`, inside or beside its existing `describe("pricing cache validation", ...)` block. This is the boundary the strip-don't-drop rule exists for — the same sanitiser runs on cache reads as on fetches:

```ts
describe("pricing cache tier validation (#103)", () => {
  it("keeps a cached model whose tier is malformed, minus the tier", () => {
    write(
      "pricing.json",
      JSON.stringify({
        timestamp: Date.now(),
        data: {
          "claude-opus-4-5": {
            inputCostPerToken: 0.000005,
            outputCostPerToken: 0.000025,
            cacheCreationCostPerToken: 0.00000625,
            cacheReadCostPerToken: 0.0000005,
            // Premium below standard: not a price.
            above200k: {
              inputCostPerToken: 0.0000001,
              outputCostPerToken: 0.0000002,
              cacheCreationCostPerToken: 0.0000003,
              cacheReadCostPerToken: 0.0000004,
            },
          },
        },
      }),
    );

    const entry = loadPricingCacheEntry();

    expect(entry!.data["claude-opus-4-5"]).toBeDefined();
    expect(entry!.data["claude-opus-4-5"]!.inputCostPerToken).toBe(0.000005);
    expect(entry!.data["claude-opus-4-5"]!.above200k).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/pricing-validation.test.ts -t "#103"`
Expected: FAIL — `sanitiseModelPricing is not a function`.

- [ ] **Step 3: Implement the sanitiser and the anchor extension**

In `src/data/pricing-validation.ts`, add after `isSaneModelPricing`:

```ts
/**
 * Bounds a whole entry, tier included. A failing TIER strips the tier and
 * keeps the model; a failing BASE drops the model, as before. The asymmetry
 * is deliberate: this runs on cache reads as well as on fetches, and losing a
 * model over a bad premium would regress the per-entry posture of #92. A
 * model without a tier prices at standard rates and is flagged approximate.
 */
export function sanitiseModelPricing(value: unknown): ModelPricing | null {
  if (!isSaneModelPricing(value)) return null;
  const pricing = value as ModelPricing;
  if (pricing.above200k === undefined) return pricing;
  if (isSaneTier(pricing.above200k, pricing)) return pricing;

  const { above200k: _rejected, ...withoutTier } = pricing;
  return withoutTier;
}

/**
 * A premium rate below its standard counterpart is not a price, it is a
 * corrupted or poisoned record — the tier exists to charge MORE. Bounds alone
 * would admit it.
 */
function isSaneTier(tier: unknown, base: RateSet): boolean {
  if (!isSaneModelPricing(tier)) return false;
  const rates = tier as RateSet;
  return COST_KEYS.every((key) => rates[key] >= base[key]);
}
```

Add `RateSet` to the type import at the top of the file.

Replace the accept condition inside `anchorToSnapshot`'s loop:

```ts
    if (
      COST_KEYS.every((k) => withinDeviation(value[k], known[k])) &&
      tierWithinDeviation(value, known)
    ) {
      out[key] = value;
    }
```

and add below `withinDeviation`:

```ts
/**
 * A tier the snapshot has no counterpart for passes on bounds alone, exactly
 * as a model absent from the snapshot does. That is the path by which a
 * newly published tier reaches users — blocking it would defeat the point of
 * consuming the feed.
 */
function tierWithinDeviation(fetched: ModelPricing, known: ModelPricing): boolean {
  if (!fetched.above200k || !known.above200k) return true;
  const f = fetched.above200k;
  const k = known.above200k;
  return COST_KEYS.every((key) => withinDeviation(f[key], k[key]));
}
```

In `sanitisePricingTable`, switch to the new function:

```ts
export function sanitisePricingTable(table: Record<string, unknown>): PricingTable {
  const out: PricingTable = {};
  for (const [key, value] of Object.entries(table)) {
    const pricing = sanitiseModelPricing(value);
    if (pricing) out[key] = pricing;
  }
  return out;
}
```

In `src/data/pricing-fetcher.ts`, replace the `isSaneModelPricing` guard in `parseLitellmPricing`:

```ts
    // Bounds before storage, so an absurd or zero price never reaches the
    // cache, the bar, or the regenerated snapshot (#91). Per entry: one
    // poisoned model must not discard the two dozen good ones — and one
    // poisoned TIER must not discard its model (#103).
    const sane = sanitiseModelPricing(pricing);
    if (!sane) continue;
```

and store `sane` rather than `pricing` in both table assignments below it. Update the import from `./pricing-validation.js` accordingly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/pricing-validation.test.ts src/__tests__/pricing-fetcher.test.ts src/__tests__/cache-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the tests are not vacuous**

Temporarily make `isSaneTier` `return true;`. The "below its standard counterpart" and "above MAX_COST_PER_TOKEN" cases must FAIL. Revert. Then temporarily make `tierWithinDeviation` `return true;` — the "drifted beyond the deviation bound" case must FAIL. Revert.

- [ ] **Step 6: Full check and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/data/pricing-validation.ts src/data/pricing-fetcher.ts src/__tests__/pricing-validation.test.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "Bound and anchor the above-200k tier (#103)"
```

---

### Task 3: Split premium tokens per request in the aggregator

**Files:**
- Modify: `src/types/token-metrics.ts`
- Modify: `src/data/token-aggregator.ts`
- Modify: `src/__tests__/token-aggregator.test.ts` — the file already exists and covers totals / byModel / model-less usage. Append a new `describe`; do not rewrite what is there.

**Interfaces:**
- Consumes: `PREMIUM_PROMPT_THRESHOLD` (Task 1).
- Produces:
  - `interface TokenCounts { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }`
  - `interface TokenMetrics extends TokenCounts { premium?: TokenCounts }`
  - `aggregateTokens` now always emits `premium` on every `TokenMetrics` it returns (all-zero when nothing crossed the threshold), on both `byModel` values and `totals`.

- [ ] **Step 1: Write the failing tests**

Append to the existing `src/__tests__/token-aggregator.test.ts`. It already imports `aggregateTokens` and `JsonlEntry`, so add only the local helper and the new `describe`:

```ts
function entry(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): JsonlEntry {
  return { model, usage } as JsonlEntry;
}

describe("aggregateTokens premium bucketing (#103)", () => {
  it("leaves the premium bucket empty for a prompt under the threshold", () => {
    const { byModel, totals } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 1000, output_tokens: 500 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    expect(totals.premium!.inputTokens).toBe(0);
  });

  it("treats a prompt of exactly 200_000 as standard", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 200_000, output_tokens: 10 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.inputTokens).toBe(0);
  });

  it("buckets a prompt of 200_001 as premium", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 200_001, output_tokens: 10 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.inputTokens).toBe(200_001);
  });

  it("counts cache reads and cache creation toward the prompt size", () => {
    // 190k cached + 20k fresh is a 210k prompt, even though input_tokens alone
    // is far under the threshold. This is the shape of a real long session.
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", {
        input_tokens: 20_000,
        cache_read_input_tokens: 190_000,
        output_tokens: 700,
      }),
    ]);

    const premium = byModel.get("claude-opus-5")!.premium!;
    expect(premium.inputTokens).toBe(20_000);
    expect(premium.cacheReadTokens).toBe(190_000);
  });

  it("bills a premium request's output tokens at the premium tier", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 300_000, output_tokens: 800 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.outputTokens).toBe(800);
  });

  it("keeps the base counts as full totals, not standard-only", () => {
    // The regression guard for every token-count widget: they read these four
    // fields and must keep seeing everything the session used.
    const { byModel, totals } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 300_000, output_tokens: 800 }),
      entry("claude-opus-5", { input_tokens: 1_000, output_tokens: 200 }),
    ]);

    const metrics = byModel.get("claude-opus-5")!;
    expect(metrics.inputTokens).toBe(301_000);
    expect(metrics.outputTokens).toBe(1_000);
    expect(metrics.premium!.inputTokens).toBe(300_000);
    expect(totals.inputTokens).toBe(301_000);
    expect(totals.premium!.inputTokens).toBe(300_000);
  });

  it("sums premium across entries per model", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 250_000, output_tokens: 100 }),
      entry("claude-sonnet-5", { input_tokens: 400_000, output_tokens: 100 }),
      entry("claude-opus-5", { input_tokens: 210_000, output_tokens: 100 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.inputTokens).toBe(460_000);
    expect(byModel.get("claude-sonnet-5")!.premium!.inputTokens).toBe(400_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/token-aggregator.test.ts`
Expected: FAIL — `premium` is `undefined`.

- [ ] **Step 3: Add the types**

In `src/types/token-metrics.ts`, replace the `TokenMetrics` declaration with:

```ts
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
```

Leave `ModelTokenMetrics` and `AggregatedMetrics` as they are — they extend/reference `TokenMetrics` and pick the change up.

- [ ] **Step 4: Bucket in the aggregator**

Rewrite the top half of `src/data/token-aggregator.ts`:

```ts
import type { JsonlEntry } from "./jsonl-reader.js";
import type { TokenCounts, TokenMetrics, AggregatedMetrics } from "../types/token-metrics.js";
import { PREMIUM_PROMPT_THRESHOLD } from "./pricing-tiers.js";

function emptyCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function emptyMetrics(): TokenMetrics {
  return { ...emptyCounts(), premium: emptyCounts() };
}

/**
 * What Anthropic bills the tier on: the size of THIS request's prompt, cached
 * tokens included. One JsonlEntry is one API request — `parseJsonlContent`
 * already merges the lines sharing a `message.id` — which is why the split
 * belongs here and not in the cost calculator, where only session sums remain.
 */
function promptTokens(usage: NonNullable<JsonlEntry["usage"]>): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function addCounts(target: TokenCounts, usage: NonNullable<JsonlEntry["usage"]>): void {
  target.inputTokens += usage.input_tokens ?? 0;
  target.outputTokens += usage.output_tokens ?? 0;
  target.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  target.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
}

function addUsage(target: TokenMetrics, entry: JsonlEntry): void {
  if (!entry.usage) return;
  addCounts(target, entry.usage);

  // Output follows the prompt's tier: the feed prices output at the premium
  // rate for a request whose prompt crossed the line.
  if (promptTokens(entry.usage) > PREMIUM_PROMPT_THRESHOLD) {
    target.premium ??= emptyCounts();
    addCounts(target.premium, entry.usage);
  }
}
```

`aggregateTokens` itself is unchanged — it already calls `emptyMetrics()` and `addUsage`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/token-aggregator.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the tests are not vacuous**

Temporarily change the threshold comparison to `>=`. The "exactly 200_000 is standard" case must FAIL. Revert. Then temporarily drop `cache_read_input_tokens` from `promptTokens` — the "counts cache reads" case must FAIL. Revert.

- [ ] **Step 7: Full check and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/types/token-metrics.ts src/data/token-aggregator.ts src/__tests__/token-aggregator.test.ts
git add -f dist/index.js
git commit -m "Split premium-tier tokens per request in the aggregator (#103)"
```

---

### Task 4: Charge the tier, and report approximated models

**Files:**
- Modify: `src/data/cost-calculator.ts`
- Test: `src/__tests__/cost-calculator.test.ts`

**Interfaces:**
- Consumes: `ModelPricing.above200k`, `RateSet` (Task 1); `TokenMetrics.premium`, `TokenCounts` (Task 3).
- Produces: `interface CostByModel { costs: Map<string, number>; unpriced: string[]; approximated: string[] }`. `calculateCost(metrics, pricing)` is tier-aware, so `calculateBurnRate` and every other caller inherits it with no change at the call site.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/cost-calculator.test.ts`:

```ts
describe("calculateCost above-200k tier (#103)", () => {
  const tiered: ModelPricing = {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
    above200k: {
      inputCostPerToken: 6 / 1_000_000,
      outputCostPerToken: 22.5 / 1_000_000,
      cacheCreationCostPerToken: 7.5 / 1_000_000,
      cacheReadCostPerToken: 0.6 / 1_000_000,
    },
  };

  it("charges standard and premium tokens at their own rates", () => {
    // 300k input total, 250k of it premium; 1000 output total, 800 premium.
    const metrics: TokenMetrics = {
      inputTokens: 300_000,
      outputTokens: 1_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      premium: {
        inputTokens: 250_000,
        outputTokens: 800,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    const expected =
      50_000 * (3 / 1_000_000) +
      200 * (15 / 1_000_000) +
      250_000 * (6 / 1_000_000) +
      800 * (22.5 / 1_000_000);

    expect(calculateCost(metrics, tiered)).toBeCloseTo(expected, 10);
  });

  it("prices premium tokens at the standard rate when no tier is published", () => {
    const metrics: TokenMetrics = {
      inputTokens: 300_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      premium: {
        inputTokens: 300_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    const untiered: ModelPricing = { ...tiered, above200k: undefined };

    expect(calculateCost(metrics, untiered)).toBeCloseTo(300_000 * (3 / 1_000_000), 10);
  });

  it("is unchanged for metrics carrying no premium bucket", () => {
    const metrics: TokenMetrics = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 100,
    };

    const expected =
      1_000 * (3 / 1_000_000) +
      500 * (15 / 1_000_000) +
      200 * (3.75 / 1_000_000) +
      100 * (0.3 / 1_000_000);

    expect(calculateCost(metrics, tiered)).toBeCloseTo(expected, 10);
  });
});

describe("calculateCostByModel approximated models (#103)", () => {
  const untiered: ModelPricing = {
    inputCostPerToken: 5 / 1_000_000,
    outputCostPerToken: 25 / 1_000_000,
    cacheCreationCostPerToken: 6.25 / 1_000_000,
    cacheReadCostPerToken: 0.5 / 1_000_000,
  };
  const tiered: ModelPricing = {
    ...untiered,
    above200k: {
      inputCostPerToken: 10 / 1_000_000,
      outputCostPerToken: 50 / 1_000_000,
      cacheCreationCostPerToken: 12.5 / 1_000_000,
      cacheReadCostPerToken: 1 / 1_000_000,
    },
  };

  function premiumMetrics(): TokenMetrics {
    return {
      inputTokens: 300_000,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      premium: {
        inputTokens: 300_000,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
  }

  it("flags a model with premium usage and no published tier, and still costs it", () => {
    const byModel = new Map([["claude-opus-5[1m]", premiumMetrics()]]);
    const result = calculateCostByModel(byModel, { "claude-opus-5": untiered });

    expect(result.approximated).toEqual(["claude-opus-5[1m]"]);
    expect(result.unpriced).toEqual([]);
    expect(result.costs.get("claude-opus-5[1m]")).toBeGreaterThan(0);
  });

  it("does not flag a model whose tier is published", () => {
    const byModel = new Map([["claude-sonnet-4-5", premiumMetrics()]]);
    const result = calculateCostByModel(byModel, { "claude-sonnet-4-5": tiered });

    expect(result.approximated).toEqual([]);
  });

  it("does not flag a model that never crossed the threshold", () => {
    const byModel = new Map([
      [
        "claude-opus-5",
        {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          premium: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        },
      ],
    ]);
    const result = calculateCostByModel(byModel, { "claude-opus-5": untiered });

    expect(result.approximated).toEqual([]);
  });

  it("reports an unpriced model as unpriced, not approximated", () => {
    const byModel = new Map([["claude-unknown-9", premiumMetrics()]]);
    const result = calculateCostByModel(byModel, {});

    expect(result.unpriced).toEqual(["claude-unknown-9"]);
    expect(result.approximated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/cost-calculator.test.ts -t "#103"`
Expected: FAIL — the tier is ignored, and `result.approximated` is `undefined`.

- [ ] **Step 3: Make costing tier-aware**

In `src/data/cost-calculator.ts`, replace `calculateCost` with:

```ts
function rateCounts(counts: TokenCounts, rates: RateSet): number {
  return (
    counts.inputTokens * rates.inputCostPerToken +
    counts.outputTokens * rates.outputCostPerToken +
    counts.cacheCreationTokens * rates.cacheCreationCostPerToken +
    counts.cacheReadTokens * rates.cacheReadCostPerToken
  );
}

/**
 * `metrics.premium` is a SUBSET of the four counts, so standard tokens are the
 * difference. When the model publishes no tier the premium tokens fall back to
 * base rates — an under-count we flag rather than guess at (#103).
 */
export function calculateCost(metrics: TokenMetrics, pricing: ModelPricing): number {
  const premium = metrics.premium;
  if (!premium) return rateCounts(metrics, pricing);

  const standard: TokenCounts = {
    inputTokens: metrics.inputTokens - premium.inputTokens,
    outputTokens: metrics.outputTokens - premium.outputTokens,
    cacheCreationTokens: metrics.cacheCreationTokens - premium.cacheCreationTokens,
    cacheReadTokens: metrics.cacheReadTokens - premium.cacheReadTokens,
  };

  return rateCounts(standard, pricing) + rateCounts(premium, pricing.above200k ?? pricing);
}
```

Add `TokenCounts` to the `token-metrics.js` type import and `RateSet` to the `pricing.js` type import.

- [ ] **Step 4: Add the approximated signal**

Extend `CostByModel` and `calculateCostByModel`:

```ts
export interface CostByModel {
  costs: Map<string, number>;
  /**
   * Models that carried tokens but had no price. Their usage is missing from
   * `costs`, so any total derived from it understates the truth.
   */
  unpriced: string[];
  /**
   * Models that billed tokens above the 200k threshold on a price list that
   * publishes no premium tier, so those tokens are costed at the standard
   * rate. Unlike `unpriced`, their usage IS in `costs` — the figure is a lower
   * bound, not a gap (#103).
   */
  approximated: string[];
}
```

```ts
export function calculateCostByModel(
  byModel: Map<string, TokenMetrics>,
  pricing: PricingTable,
): CostByModel {
  const costs = new Map<string, number>();
  const unpriced: string[] = [];
  const approximated: string[] = [];

  for (const [model, metrics] of byModel) {
    const modelPricing = findPricing(model, pricing);
    if (modelPricing) {
      costs.set(model, calculateCost(metrics, modelPricing));
      if (!modelPricing.above200k && hasPremiumTokens(metrics)) approximated.push(model);
    } else if (hasTokens(metrics)) {
      // A model with no tokens loses nothing by going unpriced, and flagging
      // it would mark the bar uncertain on renders where nothing is missing.
      unpriced.push(model);
    }
  }

  return { costs, unpriced, approximated };
}

function hasPremiumTokens(metrics: TokenMetrics): boolean {
  const premium = metrics.premium;
  return (
    premium !== undefined &&
    (premium.inputTokens > 0 ||
      premium.outputTokens > 0 ||
      premium.cacheCreationTokens > 0 ||
      premium.cacheReadTokens > 0)
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/cost-calculator.test.ts`
Expected: PASS, pre-existing cases included.

- [ ] **Step 6: Prove the tests are not vacuous**

Temporarily change `pricing.above200k ?? pricing` to `pricing`. The first tier test must FAIL. Revert. Then temporarily make `hasPremiumTokens` `return false;` — the flagging test must FAIL. Revert.

- [ ] **Step 7: Full check and commit**

Other call sites (`pipeline.ts`, `cli.ts`) destructure only `costs` and `unpriced`, so they still compile; Task 6 wires the new field through.

```bash
npm test && npm run typecheck && npm run build
git add src/data/cost-calculator.ts src/__tests__/cost-calculator.test.ts
git add -f dist/index.js
git commit -m "Charge the above-200k tier and report approximated models (#103)"
```

---

### Task 5: Migrate the today-aggregate cache

**Files:**
- Modify: `src/cache/today-aggregate-cache.ts`
- Test: `src/__tests__/today-aggregate-cache.test.ts` (append to its existing `describe("getTodayAggregate", ...)`)

**Interfaces:**
- Consumes: `TokenCounts` (Task 3), and `aggregateTokens` always emitting `premium`.
- Produces: nothing new for later tasks. The on-disk schema now **requires** `premium` on every `TokenMetrics`.

**Why required rather than optional-with-default:** an optional field would let a pre-upgrade entry silently report zero premium tokens and under-cost today's spend for the rest of the day. Requiring it fails validation, `readJsonValidated` discards the file, and today's transcripts are re-parsed once. Whole-file discard costs only speed here.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("getTodayAggregate", ...)` in `src/__tests__/today-aggregate-cache.test.ts`. Reuse that file's helpers — `write(name, lines)` (writes a transcript, returns its path), `line(model, input, when)`, `parsedPaths()` (the re-parse spy), and the `NOW` / `EARLIER_TODAY` constants.

**The stale cache entry must point at a real transcript whose `mtimeMs` and `size` match.** `getTodayAggregate` rebuilds its result from the files that exist *now*, so an entry keyed on a vanished path contributes nothing whether it validated or not — such a test passes without the schema change and proves nothing. The entry therefore claims a wildly different count for a file that really is there: honouring it returns the bogus figure, discarding it returns the file's true one.

```ts
  it("discards a pre-upgrade cache entry that has no premium bucket (#103)", () => {
    const filePath = write("a", [line("opus", 100, EARLIER_TODAY)]);
    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");

    // Prime the cache, then rewrite it in the PRE-UPGRADE shape (no `premium`)
    // with a bogus count, keyed on the live file's real mtime and size so it
    // would be a cache HIT if the schema still accepted it.
    getTodayAggregate(NOW);
    const primed = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as { date: string };
    const stat = fs.statSync(filePath);
    const bogus = {
      inputTokens: 999_999,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        // Reuse the primed file's own date key rather than recomputing it: the
        // module keys on the LOCAL date, and a hand-rolled UTC key makes this
        // pass or fail depending on timezone and hour.
        date: primed.date,
        files: {
          [filePath]: {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            byModel: [["opus", bogus]],
            totals: bogus,
          },
        },
      }),
    );
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    // 100, not 999_999: the pre-upgrade shape was rejected and the transcript
    // re-parsed.
    expect(parsedPaths()).toHaveLength(1);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.totals.premium).toBeDefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/today-aggregate-cache.test.ts -t "#103"`
Expected: FAIL — the stale entry validates today, so `inputTokens` is 999999 and nothing was re-parsed.

- [ ] **Step 3: Require premium in the schema**

In `src/cache/today-aggregate-cache.ts`, replace the schema and the local helpers:

```ts
const TokenCountsSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheCreationTokens: v.number(),
  cacheReadTokens: v.number(),
});

/**
 * `premium` is REQUIRED, so a cache file written before the tier split fails
 * validation and is discarded rather than read as "no premium tokens" — a
 * wrong total for the rest of the day is worse than one re-parse (#103).
 */
const TokenMetricsSchema = v.object({
  ...TokenCountsSchema.entries,
  premium: TokenCountsSchema,
});
```

Replace `emptyMetrics` and `addInto` so the premium bucket accumulates alongside the base counts:

```ts
function emptyCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function emptyMetrics(): TokenMetrics {
  return { ...emptyCounts(), premium: emptyCounts() };
}

function addCountsInto(target: TokenCounts, source: TokenCounts): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
}

function addInto(target: TokenMetrics, source: TokenMetrics): void {
  addCountsInto(target, source);
  if (source.premium) {
    target.premium ??= emptyCounts();
    addCountsInto(target.premium, source.premium);
  }
}
```

Update the type import to `import type { TokenCounts, TokenMetrics } from "../types/token-metrics.js";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/today-aggregate-cache.test.ts src/__tests__/cache-validation.test.ts src/__tests__/today-read-flatness.test.ts src/__tests__/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the test is not vacuous**

Temporarily change `premium: TokenCountsSchema` to `premium: v.optional(TokenCountsSchema)`. The migration test must FAIL with `999999` — the stale entry validated and was served. Revert.

- [ ] **Step 6: Full check and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/cache/today-aggregate-cache.ts src/__tests__/today-aggregate-cache.test.ts
git add -f dist/index.js
git commit -m "Require the premium bucket in the today-aggregate cache (#103)"
```

---

### Task 6: Surface the approximation in the bar and the CLI

**Files:**
- Modify: `src/types/render-context.ts`
- Modify: `src/data/pipeline.ts:99-131`
- Modify: `src/widgets/per-model-breakdown.ts`
- Modify: `src/cli.ts:43-70`
- Modify: `src/__tests__/fixtures/context-from-fixture.ts:28`
- Modify: `src/__tests__/widgets.test.ts` (`makeContext`, line ~28 — it builds a full `RenderContext` literal, so it will not compile without the new field)
- Test: `src/__tests__/pipeline.test.ts`, `src/__tests__/widgets.test.ts`

**Interfaces:**
- Consumes: `CostByModel.approximated` (Task 4), `TokenMetrics.premium` (Task 3).
- Produces: `RenderContext.approximatedModels: string[]`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/widgets.test.ts`, first add `approximatedModels: []` to the `makeContext` literal (beside `unpricedModels: []`), then append:

```ts
describe("perModelBreakdownWidget approximation marker (#103)", () => {
  it("marks an approximated model's amount with ?", () => {
    const context = makeContext({
      costByModel: new Map([["claude-opus-5", 12.4]]),
      approximatedModels: ["claude-opus-5"],
    });

    const result = perModelBreakdownWidget.render(context, { type: "per-model" });
    expect(result!.text).toBe("Opus 5:$12.40?");
  });

  it("leaves a fully priced model unmarked", () => {
    const context = makeContext({
      costByModel: new Map([["claude-opus-5", 12.4]]),
      approximatedModels: [],
    });

    const result = perModelBreakdownWidget.render(context, { type: "per-model" });
    expect(result!.text).toBe("Opus 5:$12.40");
  });
});
```

In `src/__tests__/pipeline.test.ts`, add a transcript helper beside the existing `writeTranscript` (which hardcodes its usage, so it cannot serve here). `PINNED_PRICING["test-model"]` has no `above200k`, which is exactly the Opus-5 situation under test:

```ts
// One turn with a 300k prompt: over the threshold, on a pinned price list
// that publishes no premium tier.
function writePremiumTranscript(sessionId: string): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        model: "test-model",
        usage: { input_tokens: 300_000, output_tokens: 0 },
      },
    }) + "\n",
  );
}
```

and append this case inside the file's existing `describe("buildRenderContext today cost", ...)` block, or a new `describe` of your own:

```ts
it("marks the session cost uncertain when a model is only approximated (#103)", async () => {
  writePremiumTranscript("session-premium");

  const context = await buildRenderContext(
    { session_id: "session-premium" },
    settingsWith("calculated"),
  );

  expect(context.approximatedModels).toEqual(["test-model"]);
  // Approximated is NOT unpriced: the usage is counted, at the standard rate.
  expect(context.unpricedModels).toEqual([]);
  expect(context.sessionCostUncertain).toBe(true);
  expect(context.sessionCostUsd).toBeCloseTo(0.3, 10);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/widgets.test.ts src/__tests__/pipeline.test.ts -t "#103"`
Expected: FAIL — `approximatedModels` does not exist on `RenderContext`.

- [ ] **Step 3: Add the context field**

In `src/types/render-context.ts`, after `unpricedModels`:

```ts
  /**
   * Models that billed tokens above the 200k threshold with no published
   * premium rate, so their cost is a lower bound. Distinct from
   * `unpricedModels`: the usage IS counted, just at the standard rate (#103).
   */
  approximatedModels: string[];
```

Widen the two uncertainty docs to mention the approximation, since they are no longer about missing prices alone.

- [ ] **Step 4: Wire the pipeline**

In `src/data/pipeline.ts`, replace the two uncertainty lines:

```ts
  // A missing price can only understate a figure the pricing table produced,
  // and so can a missing premium tier. The stdin cost and the daily store are
  // unaffected, so marking them would be a false alarm — and a bar that cries
  // uncertain on every render is a bar nobody reads.
  const sessionCostUncertain =
    sessionCostSource === "calculated" &&
    (session.unpriced.length > 0 || session.approximated.length > 0);
  const todayCostUncertain =
    today !== null && (today.unpriced.length > 0 || today.approximated.length > 0);
```

and add to the returned object, beside `unpricedModels`:

```ts
    approximatedModels: session.approximated,
```

- [ ] **Step 5: Mark the breakdown widget**

In `src/widgets/per-model-breakdown.ts`, replace the priced-model loop body:

```ts
    for (const [model, cost] of context.costByModel) {
      // Model names render in full. The old abbreviation took the first letter
      // of each space-separated word, which dropped the minor version and
      // collapsed "Sonnet 4.5" and "Sonnet 4" to the same "S4" — two segments
      // labelled identically in the one widget whose entire job is telling
      // models apart (#63). Nothing is shortened now, so nothing can collide.
      //
      // A trailing `?` means the amount is a lower bound: tokens billed above
      // the 200k threshold on a model with no published premium rate (#103).
      const approximate = context.approximatedModels.includes(model) ? "?" : "";
      parts.push(`${formatModelName(model)}:${formatDollars(cost)}${approximate}`);
    }
```

- [ ] **Step 6: Update the fixture helper**

In `src/__tests__/fixtures/context-from-fixture.ts`, beside `unpricedModels: []`:

```ts
    approximatedModels: [],
```

- [ ] **Step 7: Update the CLI report**

In `src/cli.ts`, replace the destructure and the total line:

```ts
  const { costs: costByModel, unpriced, approximated } = calculateCostByModel(byModel, pricing);
  const totalCost = calculateTotalCost(costByModel);

  const marker =
    unpriced.length > 0 ? " (partial)" : approximated.length > 0 ? " (approximate)" : "";

  console.log("=== Today's Usage ===\n");
  console.log(`Total Cost: ${formatDollars(totalCost)}${marker}`);
```

and add after the existing `unpriced` block:

```ts
  // Distinct from the unpriced sentence above, which would be false here: the
  // usage IS in the total, charged at the standard rate because the feed
  // publishes no premium rate for that model (#103).
  if (approximated.length > 0) {
    const premiumTokens = approximated.reduce(
      (sum, model) => sum + premiumTokenTotal(byModel.get(model)),
      0,
    );
    console.log(
      `\n${approximated.join(", ")} billed ${formatTokens(premiumTokens)} tokens above the ` +
        `${formatTokens(PREMIUM_PROMPT_THRESHOLD)} threshold; no premium rate is published for ` +
        `them, so those tokens are costed at the standard rate. The real total is higher.`,
    );
  }
```

Add the helper near the bottom of the file:

```ts
function premiumTokenTotal(metrics: TokenMetrics | undefined): number {
  const premium = metrics?.premium;
  if (!premium) return 0;
  return (
    premium.inputTokens +
    premium.outputTokens +
    premium.cacheCreationTokens +
    premium.cacheReadTokens
  );
}
```

Add the imports: `import { PREMIUM_PROMPT_THRESHOLD } from "./data/pricing-tiers.js";` and `import type { TokenMetrics } from "./types/token-metrics.js";`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. The widget-reality harness must stay green — `widget-reality-pipeline.test.ts` asserts with `toHaveProperty`, not deep equality, so the new field and the new `premium` bucket do not disturb it.

- [ ] **Step 9: Prove the tests are not vacuous**

Temporarily revert `sessionCostUncertain` to the `unpriced`-only condition. The pipeline test must FAIL. Revert. Temporarily drop the `approximate` suffix in the widget — the marker test must FAIL. Revert.

- [ ] **Step 10: Full check and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/types/render-context.ts src/data/pipeline.ts src/widgets/per-model-breakdown.ts src/cli.ts src/__tests__/fixtures/context-from-fixture.ts src/__tests__/widgets.test.ts src/__tests__/pipeline.test.ts
git add -f dist/index.js
git commit -m "Surface the tier approximation on the bar and in the CLI (#103)"
```

---

### Task 7: Regenerate the offline snapshot and guard its tier rates

**Files:**
- Modify: `src/data/fallback-pricing.ts` (generated — do not hand-edit)
- Modify: `src/__tests__/fallback-pricing.test.ts`

**Interfaces:**
- Consumes: everything above. `npm run pricing` runs the real `parseLitellmPricing`, so the regenerated snapshot picks up tier blocks automatically.
- Produces: nothing for later tasks.

- [ ] **Step 1: Extend the snapshot sanity test**

In `src/__tests__/fallback-pricing.test.ts`, inside the `"carries only sane rates"` test, after the existing per-model assertions, add:

```ts
        const tier = pricing.above200k;
        if (tier) {
          for (const rate of [
            tier.inputCostPerToken,
            tier.outputCostPerToken,
            tier.cacheCreationCostPerToken,
            tier.cacheReadCostPerToken,
          ]) {
            expect(Number.isFinite(rate), `${model}: non-finite tier rate`).toBe(true);
            expect(rate, `${model}: non-positive tier rate`).toBeGreaterThan(0);
          }
          expect(
            tier.inputCostPerToken,
            `${model}: premium input priced below standard`,
          ).toBeGreaterThanOrEqual(pricing.inputCostPerToken);
          expect(
            tier.outputCostPerToken,
            `${model}: premium output priced below standard`,
          ).toBeGreaterThanOrEqual(pricing.outputCostPerToken);
        }
```

Add a new test in the same `describe`:

```ts
    it("carries the tier the feed publishes for the long-context Sonnets", () => {
      // Verified against the live feed on 2026-08-03. If Anthropic or LiteLLM
      // withdraws the tier this fails loudly, which is the point: the snapshot
      // silently losing a rate is how #82 happened.
      expect(FALLBACK_PRICING["claude-sonnet-4-5"]?.above200k).toBeDefined();
      expect(FALLBACK_PRICING["claude-sonnet-4-20250514"]?.above200k).toBeDefined();
    });

    it("has no invented tier for a model the feed does not publish one for", () => {
      // The whole point of #103's design: an unpublished premium is flagged,
      // never guessed at.
      expect(FALLBACK_PRICING["claude-opus-5"]?.above200k).toBeUndefined();
    });
```

- [ ] **Step 2: Run to verify the new assertions fail against the old snapshot**

Run: `npx vitest run src/__tests__/fallback-pricing.test.ts`
Expected: FAIL on "carries the tier the feed publishes" — the committed snapshot predates tier parsing.

- [ ] **Step 3: Regenerate the snapshot**

Run: `npm run pricing`

This fetches the live feed and rewrites `src/data/fallback-pricing.ts` through the real parser. Inspect the diff: the Sonnet 4/4.5 keys gain an `above200k` block, and no other rate should move. If unrelated rates changed, that is a genuine upstream price move — note it in the commit message rather than reverting it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Prove the new tests are not vacuous**

Hand-delete one `above200k` block from the regenerated `src/data/fallback-pricing.ts`. The "carries the tier" test must FAIL. Restore it with `npm run pricing`.

- [ ] **Step 6: Full check and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/data/fallback-pricing.ts src/__tests__/fallback-pricing.test.ts
git add -f dist/index.js
git commit -m "Regenerate the offline snapshot with above-200k tiers (#103)"
```

- [ ] **Step 7: File the follow-up issue**

The spec's named non-goal, kept out of this change deliberately:

```bash
gh issue create --title "cache_creation_input_token_cost_above_1hr is dropped, under-costing 1-hour cache writes" --body "$(cat <<'EOF'
`parseLitellmPricing` reads `cache_creation_input_token_cost` and ignores `cache_creation_input_token_cost_above_1hr`, which the LiteLLM feed publishes on every current `claude-*` entry (roughly 1.6x the 5-minute rate — e.g. Opus 5 at 6.25e-6 vs 1e-5).

A session using the 1-hour cache TTL therefore under-costs its cache writes, silently, in `calculated` mode.

Separate dimension from #103's above-200k tier: that one keys on the request's prompt size, this one keys on the cache TTL the request asked for. Whether the transcript even records which TTL was used needs checking before this is actionable — if it does not, the honest outcome is a documented limitation rather than a guess.

Spun off from #103 (see docs/superpowers/specs/2026-08-03-tiered-context-pricing-design.md, Non-goals).
EOF
)" --label "audit-P3"
```

---

## Final verification

- [ ] `npm test && npm run typecheck && npm run build` all clean.
- [ ] `git status` shows no unstaged `dist/index.js` — CI's `bundle-drift` job compares byte-for-byte.
- [ ] Manual smoke: run the built bundle against a real payload and confirm the bar renders. From the repo root:
  `cat src/__tests__/fixtures/real-payloads/*.json | node -e "const fs=require('fs');const fx=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(fx.stdin))" | node dist/index.js`
  (If the fixture layout makes that awkward, pipe any captured stdin JSON instead — the point is that the shipped bundle still produces a bar.)
- [ ] Confirm on your own machine, in `calculated` mode, that a long `claude-opus-5[1m]` session now renders `$N.NN?` rather than an unmarked figure.
