# Tiered (above-200k) context pricing

Issue: #103 — "1M-context models price at standard rates (`claude-opus-5[1m]`)"
Date: 2026-08-03

## Problem

`parseLitellmPricing` reads four fields per model — `input_cost_per_token`,
`output_cost_per_token`, `cache_creation_input_token_cost`,
`cache_read_input_token_cost` — and discards everything else. The LiteLLM feed
also publishes a long-context tier for the models that have one:

```
claude-sonnet-4-5:
  input_cost_per_token:                                 0.000003
  input_cost_per_token_above_200k_tokens:               0.000006    (2x)
  output_cost_per_token:                                0.000015
  output_cost_per_token_above_200k_tokens:              0.0000225   (1.5x)
  cache_creation_input_token_cost_above_200k_tokens:    0.0000075
  cache_read_input_token_cost_above_200k_tokens:        0.0000006
```

So a Sonnet 4 / 4.5 session whose requests exceed 200k tokens is under-costed
**today**, in `calculated` mode, using rates already present in the cache file.
The issue framed this as "wait for LiteLLM to publish the tier"; the feed
publishes it already for five keys — `claude-sonnet-4-5`,
`claude-sonnet-4-5-20250929`, `claude-sonnet-4-5-20250929-v1:0`,
`claude-sonnet-4-20250514`, and `claude-4-sonnet-20250514`. Verified against
the live feed on 2026-08-03.

`claude-opus-5` carries **no** above-200k fields, and no `claude-opus-5[1m]`
key exists. For that model the premium is genuinely unpublished, so no amount
of tier support can price it. Inventing a local rate was ruled out while
fixing #82 and stays ruled out: it would diverge silently from the feed the
moment LiteLLM adds one.

## The rule being modelled

Anthropic charges the premium **per request**, on requests whose prompt
exceeds 200k tokens. It is not a session-cumulative threshold.

This is the constraint that shapes the design. `aggregateTokens` sums usage
across turns into one `TokenMetrics` per model, destroying exactly the
granularity the rule needs: 50 turns of 60k each is 3M cumulative input at
*standard* rates. Applying the tier to a session aggregate would over-charge
about as badly as ignoring it under-charges. The split therefore has to happen
in `aggregateTokens`, where per-entry usage is still visible.

Entry granularity is correct because `parseJsonlContent` already merges lines
sharing a `message.id`, so one `JsonlEntry` is one API request.

## Design

### 1. Data model

```ts
// src/types/pricing.ts
interface RateSet {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number;
  cacheReadCostPerToken: number;
}
interface ModelPricing extends RateSet {
  /** Rates for requests over PREMIUM_PROMPT_THRESHOLD. Absent when the feed publishes none. */
  above200k?: RateSet;
}

// src/types/token-metrics.ts
interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
interface TokenMetrics extends TokenCounts {
  /** Subset of the counts above, billed at the premium tier. */
  premium?: TokenCounts;
}
```

`premium` is a **subset** of the four counts, not a sibling bucket. The base
fields keep holding full totals, so standard tokens are `total − premium` and
every existing consumer — `tokens-input`, `tokens-output`, `tokens-cached`,
`token-breakdown`, `per-model`, burn rate — is untouched. A sibling-bucket
shape would make each of those under-report the moment costing gained a
dimension; that is the mistake this shape exists to avoid.

### 2. Bucketing

New constant, in `src/data/pricing-tiers.ts` alongside the field names it
belongs to:

```ts
export const PREMIUM_PROMPT_THRESHOLD = 200_000;
```

In `aggregateTokens`, per entry carrying usage:

```
prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
if (prompt > PREMIUM_PROMPT_THRESHOLD) → add the entry's counts into `premium` as well
```

Output tokens follow the prompt's tier, because the feed prices output at the
premium rate when the prompt crosses the line. The comparison is strictly
greater-than: exactly 200_000 is standard.

For a 200k-context model the bucket can never fill, so behaviour for every
existing model is provably unchanged. The blast radius is 1M-context sessions.

### 3. Parsing, bounds, anchoring

`parseLitellmPricing` reads the four `*_above_200k_tokens` fields. A tier is
attached only when **both** `input_cost_per_token_above_200k_tokens` and
`output_cost_per_token_above_200k_tokens` are numbers; missing cache premiums
derive off the premium input rate exactly as the base ones derive off the base
input rate (x1.25 creation, x0.1 read).

`pricing-validation.ts` gains `sanitiseModelPricing(value): ModelPricing | null`,
and `isSaneModelPricing` stays as the base-field boolean it is today.
The new function:

- returns `null` when the base fields fail — unchanged behaviour, model dropped;
- **strips the tier and keeps the model** when the tier fails.

The distinction matters because the same code path validates cache reads
(`sanitisePricingTable` → `loadPricingCacheEntry`) as validates fetches.
Dropping a whole model over a bad premium would be a regression against #92's
per-entry posture; falling back to standard rates plus the approximate flag is
the honest degradation.

A tier fails when any of its four rates is non-finite, negative, or above
`MAX_COST_PER_TOKEN`, **or when any premium rate is below its standard
counterpart**. A premium cheaper than standard is not a price, it is a
corrupted or poisoned record.

`anchorToSnapshot` extends to the tier:

- both fetched and snapshot have a tier → each of the four tier rates must sit
  within `MAX_SNAPSHOT_DEVIATION` of its snapshot counterpart;
- snapshot has no tier, fetched does → passes on bounds alone, matching how a
  model absent from the snapshot is treated. This is the "LiteLLM finally
  published it" path, and it must not be blocked;
- snapshot has a tier, fetched does not → the entry is kept as-is and the
  model reverts to standard rates plus the approximate flag. The per-model
  merge in `fetchPricing` replaces whole entries, so the snapshot's tier does
  not survive a feed that de-published it. Live prices win; that is deliberate.

Without this, the tier would be an unanchored injection path — precisely what
#91 closed for base rates.

### 4. Costing and the approximate signal

`calculateCost` becomes tier-aware, so every caller (session costs, today,
per-model, burn rate) inherits it:

```
standard = counts − (premium ?? zero)
cost = standard · base + premium · (above200k ?? base)
```

`calculateCostByModel` returns `{ costs, unpriced, approximated }`. A model is
**approximated** when it has premium tokens and its resolved pricing has no
`above200k`. It still gets a cost — the figure is a lower bound, not a gap.

Plumbing:

- `RenderContext` gains `approximatedModels: string[]`.
- `sessionCostUncertain` / `todayCostUncertain` OR in the approximated list, so
  the bar's existing `?` covers it with no widget change.
- `per-model-breakdown` suffixes `?` on an approximated model's amount.
- `cli.ts` prints `(approximate)` beside the total and a sentence naming the
  model, the volume above the threshold, and that the real total is higher —
  distinct from the existing "their usage is missing from the total", which
  would be false here.

No `[1m]` suffix parsing anywhere. `findPricing("claude-opus-5[1m]")` already
resolves forward to `claude-opus-5`, and the flag falls out of "has premium
tokens, has no premium rate". Any future 1M model is covered without a code
change, and the flag clears by itself the day LiteLLM publishes Opus 5's tier.

### 5. Cache migration

`today-aggregate-cache.ts`'s `TokenMetricsSchema` gains `premium` as a
**required** field. Pre-upgrade entries fail validation, the file is discarded,
and today's transcripts are re-parsed once. `v.optional` with a zero default
would let a stale entry silently report no premium tokens — a wrong total is a
worse outcome than one re-parse, and the whole-file discard costs only speed
here.

`aggregateTokens` therefore always emits `premium`, even all-zero. The TS field
stays optional so that call sites which construct `TokenMetrics` by hand
(tests, the stdin path) are unaffected.

### 6. Snapshot regeneration

`npm run pricing` regenerates `src/data/fallback-pricing.ts` through the same
`parseLitellmPricing`, so the snapshot picks up tier blocks for the Sonnet
keys. `src/__tests__/fallback-pricing.test.ts` continues to guard it.

## Non-goals

- `cache_creation_input_token_cost_above_1hr` — published on every model and
  likewise dropped today, a real but separate under-count. File as its own
  issue.
- Inventing an Opus 5 1M rate.
- Anything on the stdin cost path: `stdin.cost.total_cost_usd` is authoritative
  and unaffected.

## Testing

Each test verified by breaking what it guards (see `vacuous-tests`).

Bucketing:
- prompt of exactly 200_000 → standard; 200_001 → premium.
- prompt size counts cache reads and cache creation, not just `input_tokens`
  (a 190k cache read plus 20k input is a premium request).
- output tokens of a premium request land in the premium bucket.
- base counts still equal full totals — the regression guard for the token
  widgets.

Pricing:
- tier fields absent → no `above200k`, cost identical to today's.
- premium below standard → tier stripped, model retained at standard rates.
- premium above `MAX_COST_PER_TOKEN` → same.
- `anchorToSnapshot`: tier within deviation passes; a 20x tier is rejected;
  a tier absent from the snapshot passes on bounds alone.
- a cached entry carrying a malformed tier loads with the model intact.

Costing and signal:
- mixed session (some premium turns, some not) priced against a hand-computed
  figure, on a model that has a tier.
- model with premium tokens and no tier → `approximated` contains it, `costs`
  still has an entry, `unpriced` does not contain it.
- model with a tier → not approximated.
- `sessionCostUncertain` true when only `approximated` is non-empty.

Cache:
- a pre-upgrade cache file (no `premium`) is discarded and recomputed.

## Delivery note

Every commit touching `src/` must run `npm run build` and stage the bundle with
`git add -f dist/index.js`. `gccusage setup` points `statusLine.command` at
`dist/index.js`, so a src-only commit ships nothing to `git pull` upgraders.
CI's `bundle-drift` job enforces byte-equality.
