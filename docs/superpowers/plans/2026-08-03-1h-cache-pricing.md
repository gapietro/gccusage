# 1-Hour Cache Write Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bill cache writes at the 1-hour rate when the request asked for a 1-hour TTL, instead of billing every cache write at the 5-minute rate.

**Architecture:** Two independent halves that meet in the cost calculator. The **rate** half teaches `parseLitellmPricing` about `cache_creation_input_token_cost_above_1hr` and its `_above_200k_tokens` cross-product sibling, deriving `input x 2` when the feed is silent or publishes a rate below its own 5-minute counterpart. The **token** half teaches `normalizeEntry` to read `usage.cache_creation.ephemeral_1h_input_tokens`. Both new quantities are modelled as **subsets** of their existing siblings — `cacheCreation1hTokens` within `cacheCreationTokens`, exactly as `premium` sits within the four base counts — so the {5m,1h} x {standard,above-200k} matrix needs no special-casing and no existing consumer changes meaning.

**Tech Stack:** TypeScript, tsdown, vitest, valibot.

**Spec:** `docs/superpowers/specs/2026-08-03-1h-cache-pricing-design.md`

## Global Constraints

- **Every commit touching `src/` must run `npm run build` and stage `dist/index.js`** (`git add -f dist/index.js` — it is gitignored but force-tracked). CI's `bundle-drift` job enforces byte-equality. A src-only commit leaves `git pull` upgraders running the old code.
- `src/` imports use `.js` specifiers (tsdown rewrites them). `scripts/` uses `.ts`. Do not "fix" either.
- New test files must live under a root already listed in `vitest.config.ts`'s `include`, or they are silently never collected.
- Coverage gate is `thresholds: {perFile: true, statements: 70}`. A new file below 70% fails CI.
- **Verify every new test by breaking what it guards** before considering it done (`docs`/memory: `vacuous-tests.md`). A test that cannot fail is a plan failure.
- Do not stage `AUDIT.md`. It is deliberately untracked.
- Branch is `1h-cache-pricing`, already created, spec already committed at `4367e8a`.

---

### Task 1: Rate resolution — the 1-hour dimension in pricing

**Files:**
- Modify: `src/types/pricing.ts` (add `cacheCreation1hCostPerToken` to `RateSet`)
- Modify: `src/data/pricing-tiers.ts:10-15` (add the two feed field names)
- Modify: `src/data/pricing-fetcher.ts:85-98` (`parseTier`), `:100-137` (`parseLitellmPricing`)
- Modify: `src/data/pricing-validation.ts:17-22` (`COST_KEYS`)
- Modify: `src/cache/pricing-cache.ts:22` (bump `PRICING_CACHE_VERSION`)
- Regenerate: `src/data/fallback-pricing.ts` (via `npm run pricing`, needs network)
- Test: `src/__tests__/pricing-fetcher.test.ts`, `src/__tests__/cache-validation.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `RateSet.cacheCreation1hCostPerToken: number` (required). `TIER_FIELDS.cacheCreation1h` and `TIER_FIELDS.cacheCreation1hAbove200k`, both `string`. `PRICING_CACHE_VERSION = 2`.

**Critical ordering — all within this one task.** The snapshot cannot be regenerated before the parser emits the field, and the field cannot join `COST_KEYS` before the snapshot carries it. Order is Step 5 (parser) → Step 7 (regenerate) → Step 8 (`COST_KEYS`). Any commit between those steps is broken, which is why they are one task and one commit.

- [ ] **Step 1: Write the failing tests for rate resolution**

Add to `src/__tests__/pricing-fetcher.test.ts`:

```ts
describe("1-hour cache creation rate", () => {
  it("uses the published above_1hr rate", () => {
    const table = parseLitellmPricing({
      "claude-test-a": {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_creation_input_token_cost: 6.25e-6,
        cache_creation_input_token_cost_above_1hr: 1e-5,
      },
    });
    expect(table["claude-test-a"]!.cacheCreation1hCostPerToken).toBe(1e-5);
  });

  it("derives input x 2 when the feed publishes no 1-hour rate", () => {
    const table = parseLitellmPricing({
      "claude-test-b": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_creation_input_token_cost: 3.75e-6,
      },
    });
    expect(table["claude-test-b"]!.cacheCreation1hCostPerToken).toBe(6e-6);
  });

  // Real broken record: claude-3-opus-20240229 publishes a 1-hour rate BELOW
  // its own 5-minute rate. A longer TTL cannot cost less, so it is repaired to
  // the derivation (1.5e-5 x 2 = 3e-5), which is Anthropic's real published
  // rate for that model.
  it("repairs a 1-hour rate that undercuts its own 5-minute rate", () => {
    const table = parseLitellmPricing({
      "claude-3-opus-20240229": {
        input_cost_per_token: 1.5e-5,
        output_cost_per_token: 7.5e-5,
        cache_creation_input_token_cost: 1.875e-5,
        cache_creation_input_token_cost_above_1hr: 6e-6,
      },
    });
    expect(table["claude-3-opus-20240229"]!.cacheCreation1hCostPerToken).toBe(3e-5);
  });

  // Documents the DELIBERATE gap in the monotonicity-only rule (spec D2).
  // claude-3-haiku publishes 6e-6 against a 3e-7 five-minute rate — 20x, and
  // wrong — but it is ABOVE its sibling, so monotonicity does not catch it.
  // Claude Code cannot run Haiku 3, so the bad rate is unreachable. If someone
  // later swaps monotonicity for a plausibility band, this test fails and
  // forces them back to spec D2 rather than letting the change pass silently.
  it("does NOT repair an implausible rate that is merely too high", () => {
    const table = parseLitellmPricing({
      "claude-3-haiku-20240307": {
        input_cost_per_token: 2.5e-7,
        output_cost_per_token: 1.25e-6,
        cache_creation_input_token_cost: 3e-7,
        cache_creation_input_token_cost_above_1hr: 6e-6,
      },
    });
    expect(table["claude-3-haiku-20240307"]!.cacheCreation1hCostPerToken).toBe(6e-6);
  });

  it("reads the above-200k cross-product rate onto the tier", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_creation_input_token_cost: 3.75e-6,
        cache_creation_input_token_cost_above_1hr: 6e-6,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 2.25e-5,
        cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
        cache_creation_input_token_cost_above_1hr_above_200k_tokens: 1.2e-5,
      },
    });
    expect(table["claude-sonnet-4-5"]!.above200k!.cacheCreation1hCostPerToken).toBe(1.2e-5);
  });

  it("derives the tier's 1-hour rate from the TIER input when absent", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-20250514": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_creation_input_token_cost: 3.75e-6,
        cache_creation_input_token_cost_above_1hr: 6e-6,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 2.25e-5,
        cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
      },
    });
    // 6e-6 (tier input) x 2 — the exact value the three sonnet-4-5 keys publish.
    expect(table["claude-sonnet-4-20250514"]!.above200k!.cacheCreation1hCostPerToken).toBe(1.2e-5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/pricing-fetcher.test.ts -t "1-hour cache creation rate"`
Expected: FAIL — `cacheCreation1hCostPerToken` is `undefined` on every assertion.

- [ ] **Step 3: Add the field to `RateSet`**

In `src/types/pricing.ts`, add to `RateSet` between `cacheCreationCostPerToken` and `cacheReadCostPerToken`:

```ts
  /**
   * Rate for a cache write requesting the 1-hour TTL. Required, not optional:
   * it is always derivable (`input x 2`), so optionality would buy nothing and
   * force a `??` at the cost site. A write's TTL is an independent dimension
   * from the prompt's size, so this appears on the base rates AND on
   * `above200k` (#118).
   */
  cacheCreation1hCostPerToken: number;
```

- [ ] **Step 4: Add the feed field names**

In `src/data/pricing-tiers.ts`, extend `TIER_FIELDS`:

```ts
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
```

- [ ] **Step 5: Resolve the rate in the parser**

In `src/data/pricing-fetcher.ts`, import the new constants:

```ts
import { TIER_FIELDS, CACHE_1H_FIELD, CACHE_1H_INPUT_MULTIPLIER } from "./pricing-tiers.js";
```

Add this helper above `parseTier`:

```ts
/**
 * A 1-hour cache write costs more than a 5-minute one, always — a longer TTL
 * cannot be cheaper. A published rate that undercuts its own 5-minute sibling
 * is therefore a corrupted record, not a price, and resolves to the derivation
 * instead.
 *
 * This REPAIRS where `isSaneTier` REJECTS, and the asymmetry is deliberate:
 * a tier can be stripped and the model still prices at standard rates, but
 * this field is required and has no safe absence state, so rejecting would
 * mean dropping the whole model over one bad sibling — regressing the
 * per-entry posture of #92. Repair degrades to exactly the value the model
 * would have taken had the feed stayed silent.
 *
 * Deliberately NOT a plausibility band. Monotonicity is a fact about how
 * caching works and cannot go stale; a band is a calibration that would
 * eventually reject a genuine repricing (#91's documented accepted risk).
 * The cost is that `claude-3-haiku`'s 20x value survives — unreachable in
 * practice, since Claude Code cannot run Haiku 3 (spec D2).
 */
function resolveCache1hRate(
  published: unknown,
  inputCost: number,
  cacheCreationCost: number,
): number {
  const derived = inputCost * CACHE_1H_INPUT_MULTIPLIER;
  if (typeof published !== "number" || !Number.isFinite(published)) return derived;
  return published < cacheCreationCost ? derived : published;
}
```

In `parseTier`, after the existing `cacheRead` line, replace the `return` block with:

```ts
  const cacheCreationCost = typeof cacheCreation === "number" ? cacheCreation : input * 1.25;
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreationCostPerToken: cacheCreationCost,
    cacheCreation1hCostPerToken: resolveCache1hRate(
      model[TIER_FIELDS.cacheCreation1hAbove200k],
      input,
      cacheCreationCost,
    ),
    cacheReadCostPerToken: typeof cacheRead === "number" ? cacheRead : input * 0.1,
  };
```

In `parseLitellmPricing`, replace the `pricing` object literal with:

```ts
    const cacheCreationCost =
      typeof model["cache_creation_input_token_cost"] === "number"
        ? model["cache_creation_input_token_cost"]
        : inputCost * 1.25;

    const pricing: ModelPricing = {
      inputCostPerToken: inputCost,
      outputCostPerToken: outputCost,
      cacheCreationCostPerToken: cacheCreationCost,
      cacheCreation1hCostPerToken: resolveCache1hRate(
        model[CACHE_1H_FIELD],
        inputCost,
        cacheCreationCost,
      ),
      cacheReadCostPerToken:
        typeof model["cache_read_input_token_cost"] === "number"
          ? model["cache_read_input_token_cost"]
          : inputCost * 0.1,
    };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/pricing-fetcher.test.ts -t "1-hour cache creation rate"`
Expected: PASS, all 6.

- [ ] **Step 7: Regenerate the offline snapshot**

`FALLBACK_PRICING` is a typed `PricingTable` literal, so it will not typecheck until it carries the new field. Regenerate it now, before `COST_KEYS` starts enforcing the field.

Run: `npm run pricing` (fetches the live feed — needs network)

Then confirm the field landed:

```bash
grep -c 'cacheCreation1hCostPerToken' src/data/fallback-pricing.ts
```
Expected: a count matching the number of entries (25+ — the file stores both the bare id and the prefixed key for some models).

Spot-check that the repair fired on the known-broken record:

```bash
grep -A 6 '"claude-3-opus-20240229"' src/data/fallback-pricing.ts
```
Expected: `"cacheCreation1hCostPerToken": 0.00003` — the derivation, NOT the feed's 6e-6.

- [ ] **Step 8: Add the field to `COST_KEYS`**

In `src/data/pricing-validation.ts`:

```ts
const COST_KEYS = [
  "inputCostPerToken",
  "outputCostPerToken",
  "cacheCreationCostPerToken",
  "cacheCreation1hCostPerToken",
  "cacheReadCostPerToken",
] as const;
```

This single line gives the new rate bounds checking, `isSaneTier`'s tier-above-base check, and `anchorToSnapshot` deviation checking, with no further change.

- [ ] **Step 9: Bump the pricing cache version**

In `src/cache/pricing-cache.ts`, change `PRICING_CACHE_VERSION` to `2` and append to its doc comment:

```
 * Bumped again for #118: `cacheCreation1hCostPerToken` joined COST_KEYS, so a
 * v1 file written by the old parser lacks it, fails bounds on read, and would
 * drop EVERY model for up to the full TTL. Rejecting the envelope instead
 * degrades to FALLBACK_PRICING, which carries the field.
```

- [ ] **Step 10: Write the cache-rejection test**

The pricing cache is tested in **`src/__tests__/cache-validation.test.ts`**, which already has a `write(name, contents)` helper and a `SANE` `ModelPricing` fixture. Add to the `describe` block that ends at line 377 (the one holding "rejects a pre-version cache file"):

```ts
  // The existing "version does not match" test uses PRICING_CACHE_VERSION + 1,
  // which is version-RELATIVE: it keeps passing after any bump without ever
  // proving the bump did its job. This pins the literal old version, so it
  // fails if someone reverts PRICING_CACHE_VERSION to 1.
  it("rejects a literal v1 cache, whose entries predate the 1-hour rate", () => {
    write(
      "pricing.json",
      JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        data: {
          "claude-opus-5": {
            inputCostPerToken: 0.000005,
            outputCostPerToken: 0.000025,
            cacheCreationCostPerToken: 0.00000625,
            cacheReadCostPerToken: 0.0000005,
          },
        },
      }),
    );
    // Rejected at the envelope. Were it accepted, every entry would then fail
    // the new COST_KEYS bounds one by one and empty the table for a full TTL.
    expect(loadPricingCacheEntry()).toBeNull();
  });
```

Note: `SANE` is typed `ModelPricing`, so `npm run typecheck` will require `cacheCreation1hCostPerToken` on it. Add it there (`0.00001`) as part of this step.

- [ ] **Step 11: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. If `fallback-pricing.ts` fails typecheck, Step 7 did not run.

- [ ] **Step 12: Verify the tests are not vacuous**

Break each guard, confirm the named test goes red, then revert:

1. In `resolveCache1hRate`, change `published < cacheCreationCost` to `false` → "repairs a 1-hour rate that undercuts its own 5-minute rate" must FAIL.
2. Change `CACHE_1H_INPUT_MULTIPLIER` to `1.25` → "derives input x 2 when the feed publishes no 1-hour rate" must FAIL.
3. In `parseTier`, pass `CACHE_1H_FIELD` instead of `TIER_FIELDS.cacheCreation1hAbove200k` → "reads the above-200k cross-product rate onto the tier" must FAIL.
4. Revert `PRICING_CACHE_VERSION` to `1` → the v1-rejection test must FAIL.

Record any sabotage that does NOT turn its test red — that test is vacuous and must be fixed, not accepted.

- [ ] **Step 13: Build and commit**

```bash
npm run build
git add src/types/pricing.ts src/data/pricing-tiers.ts src/data/pricing-fetcher.ts \
        src/data/pricing-validation.ts src/data/fallback-pricing.ts \
        src/cache/pricing-cache.ts src/__tests__/pricing-fetcher.test.ts \
        src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "Resolve a 1-hour cache write rate for every model (#118)"
```

---

### Task 2: Token extraction — read the TTL split from transcripts

**Files:**
- Modify: `src/data/jsonl-reader.ts:3-15` (`JsonlEntry`), `:116-130` (`normalizeEntry`)
- Test: `src/__tests__/jsonl-reader.test.ts` (confirmed present)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `JsonlEntry["usage"]` gains `cache_creation_1h_input_tokens?: number`, already clamped to `cache_creation_input_tokens`.

**Naming note:** the normalized field is `cache_creation_1h_input_tokens` (snake_case, matching its siblings on `usage`), *not* the feed's nested `cache_creation.ephemeral_1h_input_tokens`. `normalizeEntry`'s whole job is flattening both transcript formats into one shape; keep that.

- [ ] **Step 1: Write the failing tests**

Add to the jsonl-reader test file:

```ts
describe("1-hour cache creation tokens", () => {
  it("reads the ephemeral_1h count out of the nested breakdown", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-03T10:00:00Z",
        message: {
          id: "msg_1",
          model: "claude-opus-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 500,
            cache_creation: {
              ephemeral_5m_input_tokens: 400,
              ephemeral_1h_input_tokens: 600,
            },
          },
        },
      }),
    );
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(600);
    // The flat total is untouched — the 1h count is a SUBSET of it, not a sibling.
    expect(entries[0]!.usage!.cache_creation_input_tokens).toBe(1000);
  });

  it("treats a missing cache_creation object as all 5-minute", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_2",
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1000 },
        },
      }),
    );
    // Honest default: transcripts predating the breakdown predate 1h caching.
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(0);
  });

  // SYNTHETIC CORRUPTION — this shape does NOT occur in real transcripts
  // (0 occurrences across 98,722 usage-bearing lines). It guards the subset
  // invariant only: calculateCost derives the 5-minute bucket by subtraction,
  // so an unclamped overshoot would yield a NEGATIVE bucket and a cost below
  // the truth. Do not read this as a real-world case.
  it("clamps a 1-hour count that exceeds the flat total", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_3",
          model: "claude-opus-5",
          usage: {
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: 500 },
          },
        },
      }),
    );
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(100);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/jsonl-reader.test.ts -t "1-hour cache creation tokens"`
Expected: FAIL — `cache_creation_1h_input_tokens` is `undefined`.

- [ ] **Step 3: Extend the `JsonlEntry` usage type**

In `src/data/jsonl-reader.ts`:

```ts
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    /**
     * The SUBSET of `cache_creation_input_tokens` written with the 1-hour TTL,
     * flattened out of the transcript's nested `cache_creation` object and
     * clamped to the flat total. 5-minute tokens are the difference (#118).
     */
    cache_creation_1h_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
```

- [ ] **Step 4: Read and clamp it in `normalizeEntry`**

Inside the `if (usage && typeof usage === "object")` block, before building `entry.usage`:

```ts
    const cacheCreation =
      typeof usage["cache_creation"] === "object" && usage["cache_creation"] !== null
        ? (usage["cache_creation"] as Record<string, unknown>)
        : undefined;
    const flatCacheCreation =
      typeof usage["cache_creation_input_tokens"] === "number"
        ? usage["cache_creation_input_tokens"]
        : 0;
    const raw1h = cacheCreation?.["ephemeral_1h_input_tokens"];
    // Clamped so the subset invariant holds no matter what the file says:
    // calculateCost subtracts to get the 5-minute bucket, and a negative
    // bucket would silently UNDER-count. Never observed in real transcripts.
    const cacheCreation1h =
      typeof raw1h === "number" && raw1h > 0 ? Math.min(raw1h, flatCacheCreation) : 0;
```

Then add to the `entry.usage` literal, after `cache_creation_input_tokens`:

```ts
      cache_creation_1h_input_tokens: cacheCreation1h,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/jsonl-reader.test.ts -t "1-hour cache creation tokens"`
Expected: PASS, all 3.

- [ ] **Step 6: Verify the tests are not vacuous**

1. Replace `Math.min(raw1h, flatCacheCreation)` with `raw1h` → "clamps a 1-hour count that exceeds the flat total" must FAIL.
2. Replace the `cacheCreation?.["ephemeral_1h_input_tokens"]` lookup with `undefined` → "reads the ephemeral_1h count out of the nested breakdown" must FAIL.

Revert both.

- [ ] **Step 7: Run the full suite, build, and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/data/jsonl-reader.ts src/__tests__/jsonl-reader.test.ts
git add -f dist/index.js
git commit -m "Read the cache TTL split out of transcript usage (#118)"
```

---

### Task 3: Aggregation and cost — spend the two halves

**Files:**
- Modify: `src/types/token-metrics.ts:1-6` (`TokenCounts`)
- Modify: `src/data/token-aggregator.ts:5-7` (`emptyCounts`), `:27-32` (`addCounts`)
- Modify: `src/data/cost-calculator.ts:5-12` (`rateCounts`), `:23-28` (standard subtraction)
- Modify: `src/cache/today-aggregate-cache.ts:18-23` (schema), `:72-74` (`emptyCounts`), `:80-85` (`addCountsInto`)
- Test: `src/__tests__/token-aggregator.test.ts`, `src/__tests__/cost-calculator.test.ts`, `src/__tests__/today-aggregate-cache.test.ts`

**Interfaces:**
- Consumes: `RateSet.cacheCreation1hCostPerToken` (Task 1), `JsonlEntry.usage.cache_creation_1h_input_tokens` (Task 2).
- Produces: `TokenCounts.cacheCreation1hTokens: number` (required).

**Expect widespread compile errors.** `TokenCounts` gains a required field, so every hand-built literal in the test suite fails `tsc`. This is intended and mechanical: add `cacheCreation1hTokens: 0` to each. Work through `npm run typecheck` output rather than guessing at the list. The affected test files are `pipeline`, `defaults`, `cost-calculator`, `renderer`, `today-aggregate-cache`, `token-aggregator`, `widgets`, `cli`.

**No change needed** in `src/widgets/tokens-cached.ts` or `src/cli.ts:112-113`: both read `cacheCreationTokens`, which still carries the full count. That is the entire point of modelling the new quantity as a subset — verify by reading them, do not edit them.

- [ ] **Step 1: Write the failing cost test**

Add to `src/__tests__/cost-calculator.test.ts`:

```ts
describe("1-hour cache write pricing", () => {
  const pricing: ModelPricing = {
    inputCostPerToken: 5e-6,
    outputCostPerToken: 2.5e-5,
    cacheCreationCostPerToken: 6.25e-6,
    cacheCreation1hCostPerToken: 1e-5,
    cacheReadCostPerToken: 5e-7,
  };

  it("splits cache writes between the 5-minute and 1-hour rates", () => {
    const cost = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1000,
        cacheCreation1hTokens: 400,
        cacheReadTokens: 0,
      },
      pricing,
    );
    // 600 x 6.25e-6 + 400 x 1e-5 = 3.75e-3 + 4e-3
    expect(cost).toBeCloseTo(0.00775, 10);
  });

  it("charges every cache write at the 5-minute rate when none asked for 1 hour", () => {
    const cost = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1000,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      },
      pricing,
    );
    expect(cost).toBeCloseTo(0.00625, 10);
  });

  // The 2x2 matrix: a request above 200k that also asked for a 1-hour TTL
  // must reach the cross-product rate, not any of the other three.
  it("bills the above-200k 1-hour rate for premium 1-hour writes", () => {
    const tiered: ModelPricing = {
      ...pricing,
      above200k: {
        inputCostPerToken: 1e-5,
        outputCostPerToken: 5e-5,
        cacheCreationCostPerToken: 1.25e-5,
        cacheCreation1hCostPerToken: 2e-5,
        cacheReadCostPerToken: 1e-6,
      },
    };
    const cost = calculateCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1000,
        cacheCreation1hTokens: 400,
        cacheReadTokens: 0,
        premium: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 1000,
          cacheCreation1hTokens: 400,
          cacheReadTokens: 0,
        },
      },
      tiered,
    );
    // All premium: 600 x 1.25e-5 + 400 x 2e-5 = 7.5e-3 + 8e-3
    expect(cost).toBeCloseTo(0.0155, 10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/cost-calculator.test.ts -t "1-hour cache write pricing"`
Expected: FAIL — typecheck errors on the unknown property, or wrong totals.

- [ ] **Step 3: Add the field to `TokenCounts`**

In `src/types/token-metrics.ts`:

```ts
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  /**
   * The SUBSET of `cacheCreationTokens` written with the 1-hour TTL. 5-minute
   * tokens are the difference. A subset and not a sibling bucket for the same
   * reason `premium` is: every consumer of `cacheCreationTokens` keeps seeing
   * the full count, so no token widget starts under-reporting the day costing
   * gains a dimension (#118).
   *
   * Because `premium` is itself a `TokenCounts`, this composes into the full
   * {5m,1h} x {standard,above-200k} matrix with no special-casing.
   */
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
}
```

- [ ] **Step 4: Accumulate it in the aggregator**

In `src/data/token-aggregator.ts`:

```ts
function emptyCounts(): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
  };
}
```

and in `addCounts`, after the `cacheCreationTokens` line:

```ts
  target.cacheCreation1hTokens += usage.cache_creation_1h_input_tokens ?? 0;
```

Because `addCounts` is also what fills `target.premium`, the premium bucket gets its own 1-hour subtotal with no further code.

- [ ] **Step 5: Spend it in the cost calculator**

In `src/data/cost-calculator.ts`, replace `rateCounts`:

```ts
function rateCounts(counts: TokenCounts, rates: RateSet): number {
  // 5-minute writes are the remainder: cacheCreation1hTokens is a SUBSET of
  // cacheCreationTokens, clamped at ingestion so this cannot go negative.
  const cacheCreation5m = counts.cacheCreationTokens - counts.cacheCreation1hTokens;
  return (
    counts.inputTokens * rates.inputCostPerToken +
    counts.outputTokens * rates.outputCostPerToken +
    cacheCreation5m * rates.cacheCreationCostPerToken +
    counts.cacheCreation1hTokens * rates.cacheCreation1hCostPerToken +
    counts.cacheReadTokens * rates.cacheReadCostPerToken
  );
}
```

and add to the `standard` literal in `calculateCost`, after `cacheCreationTokens`:

```ts
    cacheCreation1hTokens: metrics.cacheCreation1hTokens - premium.cacheCreation1hTokens,
```

Leave `hasTokens` and `hasPremiumTokens` alone: a non-zero `cacheCreation1hTokens` implies a non-zero `cacheCreationTokens`, so adding it to either predicate would be dead code.

- [ ] **Step 6: Extend the persisted schema**

In `src/cache/today-aggregate-cache.ts`, add to `TokenCountsSchema` after `cacheCreationTokens`:

```ts
  cacheCreation1hTokens: v.pipe(v.number(), v.minValue(0)),
```

Append to that schema's existing doc comment:

```
 * `cacheCreation1hTokens` is likewise REQUIRED, so a file written before the
 * TTL split fails validation and is discarded rather than read as "no 1-hour
 * tokens" — which would under-cost the rest of the day (#118).
```

Update `emptyCounts` and `addCountsInto` in the same file:

```ts
function emptyCounts(): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
  };
}
```

```ts
  target.cacheCreation1hTokens += source.cacheCreation1hTokens;
```

- [ ] **Step 7: Write the cache-migration test**

**`today-aggregate-cache.ts` exports exactly two things: the `TodayAggregate`
interface and `getTodayAggregate(now?: Date)`. There is no reader that returns
null** — a discarded cache is invisible in the return value, because
`getTodayAggregate` simply rebuilds and returns the same totals either way.

So the migration cannot be asserted on the returned value. Assert it on
**re-parsing**, using the pass-through spy this file already installs at the
top (`vi.mock("../data/jsonl-reader.js", ...)` wrapping `parseJsonlFile`) and
its `parsedPaths()` helper. Reuse the file's existing `projectDir()`, `line()`,
and `write()` helpers rather than writing new ones.

Add to `src/__tests__/today-aggregate-cache.test.ts`:

```ts
it("re-parses a transcript whose cached aggregate predates the TTL split", () => {
  const filePath = write("session.jsonl", [line("claude-opus-5", 100, new Date())]);
  const stat = fs.statSync(filePath);

  // A pre-#118 aggregate: correct mtimeMs and size, so it WOULD be reused —
  // but no cacheCreation1hTokens anywhere. Reading it as "0 one-hour tokens"
  // would under-cost every 1-hour write for the rest of the day, so the
  // required field must make validation discard it and force a re-parse.
  const preSplitCounts = {
    inputTokens: 100,
    outputTokens: 0,
    cacheCreationTokens: 1000,
    cacheReadTokens: 0,
  };
  writeCacheFile({
    date: localDateKey(new Date()),
    files: {
      [filePath]: {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        byModel: [["claude-opus-5", { ...preSplitCounts, premium: preSplitCounts }]],
        totals: { ...preSplitCounts, premium: preSplitCounts },
      },
    },
  });

  getTodayAggregate();
  expect(parsedPaths()).toContain(filePath);
});
```

**Before writing this, read the top ~40 lines of the file** and confirm the
exact names of `write`, `line`, `projectDir`, and `parsedPaths`, and how it
writes the cache file and derives the date key. The bodies of those helpers
were elided when this plan was written; `writeCacheFile` and `localDateKey`
above are placeholders for whatever that file actually uses — if it has no
cache-writing helper, write the JSON directly to
`path.join(cacheDir, "today-aggregates.json")` following the pattern in its
other cache-hit tests.

**Guard against a vacuous pass:** this test only means something if the same
setup with a *post*-split aggregate is reused. Confirm the file already has a
"reuses a cached aggregate" test; if it does not, add the mirror case
(identical, but with `cacheCreation1hTokens: 0` present) and assert
`parsedPaths()` does **not** contain the path. Without that pair, the test
passes even if the cache is never consulted at all.

- [ ] **Step 8: Fix the compile errors across the suite**

Run: `npm run typecheck`

Add `cacheCreation1hTokens: 0` to every failing `TokenCounts` literal. Do not change any existing expected cost value — if a cost assertion changes, the subset modelling is wrong and you must stop and re-read spec D4 rather than adjusting the expectation.

- [ ] **Step 9: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 10: Verify the tests are not vacuous**

1. In `rateCounts`, change `cacheCreation5m` back to `counts.cacheCreationTokens` → "splits cache writes between the 5-minute and 1-hour rates" must FAIL.
2. In `rateCounts`, use `rates.cacheCreationCostPerToken` for the 1-hour term → the same test must FAIL.
3. In `calculateCost`, drop the new `cacheCreation1hTokens` line from `standard` → "bills the above-200k 1-hour rate for premium 1-hour writes" must FAIL.
4. Make `cacheCreation1hTokens` optional in `TokenCountsSchema` (`v.optional(...)`) → the migration test must FAIL.
5. In `addCounts`, delete the `cacheCreation1hTokens` accumulation → at least one `token-aggregator` test must FAIL. **If none does**, the aggregator has no coverage of the new field and you must add a test that aggregates two entries with differing 1-hour counts before proceeding.

- [ ] **Step 11: Build and commit**

```bash
npm run build
git add src/types/token-metrics.ts src/data/token-aggregator.ts src/data/cost-calculator.ts \
        src/cache/today-aggregate-cache.ts src/__tests__/
git add -f dist/index.js
git commit -m "Bill 1-hour cache writes at the 1-hour rate (#118)"
```

---

### Task 4: End-to-end verification on the shipped bundle

**Files:**
- Test: `src/__tests__/offline-render.test.ts` (extend — check the existing offline/cold-cache pattern first)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing consumed downstream.

**Why this task exists:** #103's final review caught a defect that every per-task review missed, because each saw only one task's diff. Unit tests pass against the source; this exercises the bundle a user actually runs, offline, with a cold cache.

- [ ] **Step 1: Write the end-to-end test**

Read the existing offline-render test for its established harness (it sets `HOME` and `XDG_CACHE_HOME` to a tmpdir and spawns the bundle). Following that pattern, add a case that:

1. Writes a transcript at `$HOME/.claude/projects/<proj>/<sessionId>.jsonl` containing one assistant entry for `claude-opus-5` with `cache_creation_input_tokens: 1000` and a nested `cache_creation: {ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000}`.
2. Pipes a stdin payload with `costSource: "calculated"` and **no** `cost.total_cost_usd`, so the session cost must be computed rather than taken from stdin.
3. Asserts the rendered cost reflects the 1-hour rate.

For `claude-opus-5` the snapshot carries `cacheCreationCostPerToken` 6.25e-6 and `cacheCreation1hCostPerToken` 1e-5, so 1000 1-hour tokens cost `$0.01`, where the old code produced `$0.00625`. Derive the exact expected string from the widget's formatter rather than hardcoding a guess — read `src/utils/format.ts` for the rounding.

- [ ] **Step 2: Run it against a fresh build**

```bash
npm run build
npx vitest run src/__tests__/offline-render.test.ts
```
Expected: PASS.

- [ ] **Step 3: Verify it is not vacuous**

Change the transcript's `ephemeral_1h_input_tokens` to `0` and `ephemeral_5m_input_tokens` to `1000`, rebuild, and confirm the test FAILS with the 5-minute figure. Revert.

This is the one sabotage that proves the whole chain — parser, snapshot, reader, aggregator, calculator, bundle — is connected.

- [ ] **Step 4: Confirm the bundle is current and CI-clean**

```bash
npm run build
git status --short dist/index.js
```
Expected: no diff. If `dist/index.js` shows as modified, an earlier task committed a stale bundle — rebuild and amend before opening the PR.

Run the full gate:

```bash
npm run typecheck && npm test && npm run coverage
```
Expected: all PASS, coverage per-file threshold met.

- [ ] **Step 5: Commit and open the PR**

```bash
git add src/__tests__/offline-render.test.ts
git add -f dist/index.js
git commit -m "Verify 1-hour cache pricing end to end on the shipped bundle (#118)"
git push -u origin 1h-cache-pricing
gh pr create --title "Bill 1-hour cache writes at the 1-hour rate (#118)" --body "$(cat <<'EOF'
Closes #118.

`parseLitellmPricing` discarded `cache_creation_input_token_cost_above_1hr` and
`normalizeEntry` discarded the transcript's `cache_creation` breakdown, so every
cache write was billed at the 5-minute rate whatever TTL it asked for.

The issue was filed conditionally, on whether transcripts record the TTL. They
do — on 98,722 of 98,722 usage-bearing lines in a local corpus, 45,032 of them
with a non-zero 1-hour count. Measured impact is +7.53% across that corpus, up
to +10.1% on Fable 5.

Two things the issue did not anticipate:

- The feed publishes a **cross-product** field,
  `cache_creation_input_token_cost_above_1hr_above_200k_tokens`, so cache
  creation is a 2x2 matrix over {5m,1h} x {standard,above-200k}. Modelling both
  new quantities as subsets — `cacheCreation1hTokens` within
  `cacheCreationTokens`, as `premium` sits within the base counts — makes the
  matrix fall out with no special-casing.
- The feed's 1-hour value is **wrong for 2 of the 23** models publishing it,
  both carrying a copy-pasted `claude-3-7-sonnet` rate. `claude-3-opus` prices a
  1-hour write BELOW its own 5-minute write.

Missing rates derive `input x 2` — matched exactly by 21 of the 23 published
records and by all three published cross-product rates. A published rate below
its 5-minute sibling is repaired to that derivation, on monotonicity alone: a
longer TTL cannot cost less. A plausibility band would also catch
`claude-3-haiku`'s 20x value, but bands go stale and reject genuine repricings,
so that one is left standing and pinned by a test — unreachable in practice,
since Claude Code cannot run Haiku 3.

Both on-disk caches are invalidated: `PRICING_CACHE_VERSION` bumps, and
`today-aggregates.json` gains a required field so pre-split files are discarded
rather than read as "no 1-hour tokens".

Design: `docs/superpowers/specs/2026-08-03-1h-cache-pricing-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| D1 — derive `input x 2` | 1, Steps 4-5 |
| D2 — monotonicity repair, haiku gap asserted | 1, Steps 1, 5 |
| D3 — repair not reject | 1, Step 5 (documented in `resolveCache1hRate`) |
| D3 residual — hand-edited cache bypasses repair | Documented in spec; no task (deliberate) |
| D4 — subset count, required rate | 1 Step 3, 3 Step 3 |
| D5 — clamp at ingestion, `rateCounts` unguarded | 2 Step 4, 3 Step 5 |
| Types | 1 Step 3, 3 Step 3 |
| Data flow 1 (jsonl-reader) | 2 |
| Data flow 2 (aggregator) | 3 Step 4 |
| Data flow 3 (TIER_FIELDS) | 1 Step 4 |
| Data flow 4 (parser) | 1 Step 5 |
| Data flow 5 (COST_KEYS) | 1 Step 8 |
| Data flow 6 (rateCounts) | 3 Step 5 |
| Persistence — today-aggregate schema | 3 Steps 6-7 |
| Persistence — PRICING_CACHE_VERSION | 1 Steps 9-10 |
| Persistence — snapshot ordering | 1, Steps 5→7→8, one commit |
| Testing — rate resolution | 1 Step 1 |
| Testing — haiku gap survives | 1 Step 1 |
| Testing — subset invariant (synthetic) | 2 Step 1 |
| Testing — cross product | 1 Step 1, 3 Step 1 |
| Testing — cache migration (`pricing.json`) | 1 Step 10 (`cache-validation.test.ts`, literal `version: 1`) |
| Testing — cache migration (`today-aggregates.json`) | 3 Step 7 (asserted via re-parse, not a null return) |
| Testing — end-to-end on bundle | 4 |
| Non-goal — stdin path untouched | No task (correct) |
| Non-goal — no `1h` marker in the bar | No task (correct) |

No gaps.

**Type consistency:** `cacheCreation1hCostPerToken` (rates) and `cacheCreation1hTokens` (counts) are used under exactly those names in Tasks 1, 3, and 4. The transcript field is `ephemeral_1h_input_tokens` (nested, read-only) and normalizes to `cache_creation_1h_input_tokens` on `JsonlEntry.usage`, consumed by that name in Task 3 Step 4. `TIER_FIELDS.cacheCreation1hAbove200k` and `CACHE_1H_FIELD` are defined in Task 1 Step 4 and used in Step 5.

**Soft spots, resolved after the first self-review pass.** The initial draft
guessed at three sets of names. All three were checked and two were wrong:

- `src/__tests__/jsonl-reader.test.ts` — exists. Confirmed.
- The pricing cache is tested in `cache-validation.test.ts`, **not**
  `pricing-validation.test.ts`. Corrected. That file's existing version test
  uses `PRICING_CACHE_VERSION + 1`, which is version-relative and would keep
  passing after the bump without proving anything, so Task 1 Step 10 pins the
  literal `1` instead.
- `readTodayAggregateCache` **does not exist**. The module exports only
  `getTodayAggregate`, which rebuilds and returns the same totals whether or
  not the cache was discarded — so the drafted `expect(...).toBeNull()` would
  not have compiled, and its premise was wrong regardless. Task 3 Step 7 now
  asserts on re-parsing via the file's existing pass-through spy, plus a mirror
  case so the assertion cannot pass vacuously.

**Remaining known gap:** the bodies of `today-aggregate-cache.test.ts`'s
helpers (`write`, `line`, `projectDir`, `parsedPaths`) were elided in the read,
so `writeCacheFile` and `localDateKey` in Task 3 Step 7 are named placeholders.
That step says so explicitly and tells the implementer to read the file first.
