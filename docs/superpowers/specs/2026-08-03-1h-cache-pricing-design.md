# Price 1-hour cache writes at the 1-hour rate (#118)

Date: 2026-08-03
Issue: [#118](https://github.com/gapietro/gccusage/issues/118)
Spun off from: #103 (see `2026-08-03-tiered-context-pricing-design.md`, Non-goals)

## Problem

`parseLitellmPricing` reads `cache_creation_input_token_cost` and discards
`cache_creation_input_token_cost_above_1hr`. Every cache write is therefore
billed at the 5-minute rate, whatever TTL the request actually asked for.

`jsonl-reader.ts` compounds it from the other side: `normalizeEntry` reads only
the flat `cache_creation_input_tokens` and drops the `cache_creation`
breakdown object entirely, so the 5m/1h split never enters the pipeline at all.
Both halves have to move for either to matter.

Affects `costSource: "calculated"` — the session bar when it resolves to
calculated, `gccusage today`, and the today-spend store.

### The issue's blocker is resolved

#118 was filed conditionally: *"Whether the transcript even records which TTL
was used needs checking before this is actionable — if it does not, the honest
outcome is a documented limitation rather than a guess."*

It records it. Transcripts carry, on the usage object:

```json
"cache_creation": {"ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 1862}
```

Measured over the local corpus (1,512 transcripts, 98,722 usage-bearing
lines): **98,722 of 98,722 carry the breakdown**, and 45,032 carry a non-zero
1-hour count. There is no coverage gap to design around.

### Impact is materially larger than "silently under-costs"

Replicating `parseJsonlContent`'s message-id merge and pricing against the live
feed, per model, over that corpus:

| model | 1h share of cache writes | current | corrected | delta |
|---|---|---|---|---|
| claude-fable-5 | 81.1% | $2934.26 | $3231.58 | +10.1% |
| claude-opus-4-8 | 41.6% | $74.51 | $80.32 | +7.8% |
| claude-opus-5 | 69.2% | $2597.58 | $2760.54 | +6.3% |
| claude-sonnet-5 | 0.0% | $553.13 | $553.17 | +0.0% |
| **all models** | | **$6188.51** | **$6654.66** | **+7.53%** |

These figures describe one machine's usage, not the software. They justify the
work; they are deliberately **not** pinned as fixtures (see Testing).

### Two dimensions, not one

The issue describes a single missing field. The feed publishes four:

- `cache_creation_input_token_cost`
- `cache_creation_input_token_cost_above_1hr`
- `cache_creation_input_token_cost_above_200k_tokens`
- `cache_creation_input_token_cost_above_1hr_above_200k_tokens`

The last is published for the three `claude-sonnet-4-5` keys. Cache-creation
tokens therefore fall into a 2x2 matrix — {5m, 1h} x {standard, above-200k} —
and the second axis is the one #103 just built.

### Only the transcript has the split

All three captured real payloads carry a bare `cache_creation_input_tokens` in
`context_window.current_usage`, with no breakdown. The fix cannot reach the
stdin path and does not need to: costing runs off JSONL.

## Decisions

### D1 — A missing 1-hour rate derives `input x 2`

`parseLitellmPricing` already derives `cacheCreation = input x 1.25` and
`cacheRead = input x 0.1` when the feed omits them. Deriving the 1-hour rate
the same way is existing policy, not a new invention, so #82's "never invent a
rate" is not in tension: #82 refused to synthesise a rate for a *tier that has
no derivation rule*, which is why #103 flags Opus 5's missing 200k tier as
`approximated` instead.

`x 2` is not a guess. Of the 23 `claude-*` keys that publish a 1-hour rate,
**21 are exactly `input x 2`** — and the only two that are not are precisely
the two provably-broken records in D2. It also matches Anthropic's public
pricing (5-minute write = 1.25x input, 1-hour write = 2x input).

The rule holds on the second dimension too. Five keys carry a full `above_200k`
tier; three of them publish `cache_creation_input_token_cost_above_1hr_above_200k_tokens`,
each at exactly `tierInput x 2` (1.2e-5). The two that omit it
(`claude-4-sonnet-20250514`, `claude-sonnet-4-20250514`) derive to 1.2e-5 —
the identical value their siblings publish.

Two base models publish no 1-hour rate today (`claude-4-opus-20250514`,
`claude-4-sonnet-20250514`). They derive.

Rejected: falling back to the 5-minute rate and flagging `approximated`. It is
the more conservative reading of #82, but it prices a 1-hour write at
`1.25x input` where the truth is `2x input` — a **37.5% under-count on every
such token** — in exchange for declining to state a number that 21 of 23
published records agree on exactly.

### D2 — A published rate below its 5-minute counterpart is repaired, not trusted

The feed is wrong for 2 of the 23 models that publish the field:

| model | input | 5m | 1h | 1h / 5m | 1h / input | derivation |
|---|---|---|---|---|---|---|
| `claude-3-opus-20240229` | 1.5e-5 | 1.875e-5 | 6e-6 | **0.32x** | 0.4x | 3e-5 |
| `claude-3-haiku-20240307` | 2.5e-7 | 3e-7 | 6e-6 | **20x** | 24x | 5e-7 |

Every healthy model sits at 1.6x the 5-minute rate and exactly 2x input. Both
outliers carry the same 6e-6 — the `claude-3-7-sonnet` value — so this reads as
one copy-paste, not two independent errors. `input x 2` reproduces Anthropic's
published rate for both.

The rule is **monotonicity only**: a 1-hour rate below the 5-minute rate is not
a price, because a longer TTL cannot cost less. `claude-3-opus` is repaired.

`claude-3-haiku`'s 20x value **survives**, and that is the accepted cost of this
rule. Rejected alternative: a band around input (roughly `[1.5x, 2.5x]`) catches
both, but it is a calibration gccusage invents, and it would reject a genuine
future repricing — the same failure mode as #91's documented accepted risk.
Monotonicity is a fact about how caching works rather than an observation about
today's price list, so it cannot go stale. Claude Code cannot run Haiku 3, so
the surviving bad rate is unreachable in practice.

### D3 — Repair, rather than reject

`isSaneTier` handles the 200k dimension by rejecting: strip the tier, keep the
model, price at standard rates, flag `approximated`.

The 1-hour rate cannot follow that pattern. It is a required field (D4) with no
safe absence state, and dropping a whole model over one bad sibling rate would
regress the per-entry posture #92 established. So a monotonicity violation
resolves to the D1 derivation — the same value the model would have taken had
the feed stayed silent.

**Residual, documented not fixed:** the repair runs at parse time only. A
hand-edited `pricing.json` carrying `1h < 5m` passes the cache read, because
bounds run on that path and the repair does not. This is the trust boundary #92
drew — cache reads get schema validation, not semantic invariants — and adding
a second enforcement point here would put the invariant in two places that must
agree.

### D4 — The 1-hour count is a subset, and the rate is required

`cacheCreation1hTokens` is a **subset** of `cacheCreationTokens`, exactly as
`premium` is a subset of the four base counts, and for the same reason
documented on `TokenMetrics.premium`: every existing consumer of
`cacheCreationTokens` keeps seeing the full count, so no token widget starts
under-reporting the day costing gains a dimension.

`cacheCreation1hCostPerToken` is **required** on `RateSet`. It is always
derivable, so optionality would buy nothing and add a `??` at the cost site.

Together these make the 2x2 matrix fall out with no special-casing: `premium`
is already a `TokenCounts` so it carries its own 1-hour count, and `above200k`
is already a `RateSet` so it carries its own 1-hour rate.

### D5 — The count is clamped at ingestion

`calculateCost` computes the 5-minute bucket by subtraction, so a 1-hour count
exceeding `cacheCreationTokens` yields a negative bucket and a cost below the
truth — the same failure shape `premium` guards against.

**This never happens in observed data.** Across 98,722 usage-bearing lines,
`ephemeral_1h_input_tokens > cache_creation_input_tokens` occurs **zero**
times. 4 lines do have `5m + 1h != flat`, but every one of those is a
discrepancy in the *5-minute* field on a subagent streaming partial, which this
change never reads.

The clamp is therefore **purely defensive** — a guard against a malformed or
hand-edited transcript, not a fix for a shape the corpus exhibits. It is worth
having because it is one `Math.min` at the boundary and the alternative failure
is a silent under-count, but the test that covers it must be labelled as
synthetic corruption rather than dressed up as a real-world case.

`cacheCreation1hTokens` is clamped to `cacheCreationTokens` in `normalizeEntry`,
where the raw usage object is read.

`rateCounts` is deliberately **not** additionally guarded (see below).

`rateCounts` is deliberately **not** guarded with `Math.max(0, ...)`. That
would hide corruption rather than prevent it, and `premium` is not guarded
there either.

## Design

### Types

```ts
// src/types/token-metrics.ts
interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheCreation1hTokens: number;  // SUBSET of cacheCreationTokens
  cacheReadTokens: number;
}

// src/types/pricing.ts
interface RateSet {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreationCostPerToken: number;
  cacheCreation1hCostPerToken: number;  // required; derives when the feed is silent
  cacheReadCostPerToken: number;
}
```

### Data flow

1. **`jsonl-reader.ts` / `normalizeEntry`** — reads
   `usage.cache_creation.ephemeral_1h_input_tokens`, defaulting to `0`. An
   absent `cache_creation` object means all tokens are 5-minute, which is
   honest: transcripts predating the breakdown predate 1-hour caching.
   Clamped per D5.
2. **`token-aggregator.ts` / `addCounts`** — accumulates the new field. Because
   `addCounts` is what fills `premium`, the premium bucket gets its own 1-hour
   subtotal with no additional code.
3. **`pricing-tiers.ts`** — `TIER_FIELDS` gains the two 1-hour feed names.
4. **`pricing-fetcher.ts` / `parseLitellmPricing`, `parseTier`** — resolve the
   rate per D1/D2/D3.
5. **`pricing-validation.ts`** — `cacheCreation1hCostPerToken` joins
   `COST_KEYS`, so bounds, `isSaneTier`'s tier-above-base check, and
   `anchorToSnapshot` all cover it without further change.
6. **`cost-calculator.ts` / `rateCounts`** — one new term:

   ```
   (counts.cacheCreationTokens - counts.cacheCreation1hTokens) * rates.cacheCreationCostPerToken
   + counts.cacheCreation1hTokens * rates.cacheCreation1hCostPerToken
   ```

### Persistence

`today-aggregate-cache.ts`'s `TokenCountsSchema` gains `cacheCreation1hTokens`
as a **required** field, so a file written by the old aggregator fails
validation and is discarded rather than read as "no 1-hour tokens". A wrong
total for the rest of the day costs more than one re-parse — the reasoning
already recorded on that schema for `premium`.

`PRICING_CACHE_VERSION` bumps. This is precisely the trap #103's final review
caught: without the bump, a `pricing.json` written by the old parser lacks
`cacheCreation1hCostPerToken`, fails the new `COST_KEYS` bounds, and every
model is dropped for up to the 24h TTL.

**Ordering constraint, within a single commit.** The snapshot cannot be
regenerated *before* the parser change, because the generator produces the new
field only once `parseLitellmPricing` emits it. Nor can the field become
required before regeneration, or every snapshot entry fails bounds and the
offline path prices nothing. The only correct order is: parser emits it →
`npm run pricing` regenerates → the field joins `COST_KEYS`. All three land
together; any commit between them is broken.

TypeScript enforces the middle step for free: `FALLBACK_PRICING` is a typed
`PricingTable` literal, so the moment `RateSet` gains a required field, the
checked-in snapshot fails `tsc` until it is regenerated. `serializeTable` uses
a bare `JSON.stringify`, so it needs no change to emit the new field.

`npm run pricing` **fetches the live feed** — it is the one step here that
needs network.

**Build constraint:** every commit touching `src/` runs `npm run build` and
stages `dist/index.js`. Enforced by CI's `bundle-drift` job.

## Testing

- **Rate resolution.** Absent → `x2`. Published → used as-is. `1h < 5m` →
  repaired, pinned to `claude-3-opus`'s real feed values (1.875e-5 / 6e-6).
- **The accepted gap is asserted, not just documented.** `claude-3-haiku`'s 20x
  value must *survive*. This test fails loudly if someone later swaps
  monotonicity for a band without revisiting D2.
- **Subset invariant (synthetic).** A hand-built usage object with
  `cache_creation_input_tokens: 100` and `ephemeral_1h_input_tokens: 500` is
  clamped to 100, so the 5-minute bucket is 0 rather than -400. The test names
  itself as synthetic corruption: no such line exists in the corpus (0 of
  98,722), and a future reader must not mistake it for a real-world shape.
- **Cross product.** A Sonnet 4.5 request above 200k with 1-hour cache writes
  bills `above_1hr_above_200k`, and not any of the other three rates.
- **Cache migration.** An old-format `today-aggregates.json` and an old-format
  `pricing.json` are each discarded, not silently mis-read.
- **End-to-end on the shipped bundle**, offline, with a cold cache — the
  pattern #103 used to catch what unit tests could not.

Per `vacuous-tests.md`, each test is verified by breaking what it guards before
it counts as done.

**Not tested:** the corpus ratios above. They are a property of one machine's
usage, and pinning them would produce a test that fails elsewhere for no
defect. Only the two structural shapes (the mismatch line, the cross-product
request) become fixtures.

## Non-goals

- **The stdin path.** `context_window.current_usage` publishes no breakdown.
  Nothing to do until it does.
- **A `1h` marker in the bar.** Unlike #103's `approximated`, the cost here is
  correct rather than a lower bound, so there is nothing to disclose.
- **Displaying the 5m/1h split** in `gccusage today` or any widget. No user
  asked; the labels are already unique and crowded.
