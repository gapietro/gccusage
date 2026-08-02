# Validate what we read: pricing feed integrity (#91) and cache files (#92)

Date: 2026-08-02
Issues: #91 (SEC-001, audit-P2), #92 (SEC-002, audit-P2)
Baseline: `de7cbe3`

## Problem

Two boundaries take external bytes on trust.

**#91 — the pricing feed.** `refreshPricing` fetches
`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
— a third party's mutable branch tip. `parseLitellmPricing` checks only that
`input_cost_per_token` and `output_cost_per_token` are of type `number`, then the
result is written to a 24h cache and drives every cost, burn rate and daily
total the bar shows. A negative, zero, or absurd price is accepted and persisted.

Separately, `findPricing`'s fuzzy fallback (`cost-calculator.ts:76-80`) returns
the **first** key that substring-matches, so upstream key *ordering* can change a
price:

```
table = { "claude-opus-4": $15/Mtok, "claude-opus-4-5-20251101": $5/Mtok }
findPricing("claude-opus-4-5-20251101-v1:0") -> $15/Mtok   (3x overcharge)
```

Latent today — every current model hits the exact-match branch first — but one
bare alias added upstream activates it.

**#92 — the cache files.** Four readers parse with `JSON.parse(raw) as T`, a
compile-time cast that checks nothing at runtime, while config gets full valibot
validation. Verified against the shipped bundle at `de7cbe3`:

```
turn-count.json = null   ->  (empty output), exit 0     <- entire bar gone
turn-count.json = 3      ->  bar renders normally
no cache file            ->  bar renders normally
```

`turn-tracker.ts` parses inside the `try` (`:25-30`) but dereferences
`data.sessionId` outside it (`:33`). `JSON.parse("null")` returns `null`, the
property access throws, and the statusline silently renders nothing. A four-byte
cache file blanks the bar.

## Non-goals

- **Pinning `LITELLM_URL` to a commit SHA.** Self-defeating: `refreshPricing`
  would re-fetch an immutable file forever and prices would freeze until someone
  bumped the constant. PR #102 already supplies the "checked-in snapshot,
  refreshed deliberately" half of the issue's suggestion as `FALLBACK_PRICING`;
  this design puts that snapshot to work as an integrity anchor instead.
- **#100 (five near-identical cache-persistence blocks).** The shared read helper
  below reduces the duplication as a side effect. Consolidating the remaining
  per-module wrappers is out of scope.
- **Surfacing rejections in the UI.** A rejected entry falls through to a correct
  snapshot price, so there is nothing to warn the user about on the bar.

## Design

### New module: `src/data/pricing-validation.ts`

Two exported checks, split by which question they answer.

**`isSaneModelPricing(p: ModelPricing): boolean`** — bounds. All four costs
finite and `>= 0`; `inputCostPerToken > 0`; every cost `<= MAX_COST_PER_TOKEN`
(`1e-3`, i.e. $1000/Mtok). The live table tops out at `7.5e-5` (Opus output), so
the ceiling sits ~13x above anything real and only rejects the absurd.

**`anchorToSnapshot(table, snapshot = FALLBACK_PRICING): PricingTable`** — for
each key also present in the snapshot, keep the fetched entry only if every cost
lands within `0.1x`-`10x` of its snapshot counterpart. Keys absent from the
snapshot (genuinely new models) pass through on bounds alone.

Rejection is **per entry**, never per table. A dropped entry falls through to its
`FALLBACK_PRICING` value via the existing merge, so one poisoned model does not
discard 24 good prices. The existing `Object.keys(pricing).length === 0` guard in
`refreshPricing`/`fetchPricing` still covers a wholly-garbage feed.

Accepted risk: a legitimate >10x price move is ignored until `npm run pricing`
regenerates the snapshot. Anthropic has never moved a price by that factor.

### Where each check is applied

**Bounds go inside `parseLitellmPricing`.** "Is this a plausible price record?"
is intrinsic to parsing, so every caller inherits it — including `npm run
pricing`, which regenerates `FALLBACK_PRICING` by calling this same function from
`src/__tests__/fallback-pricing.test.ts`.

**The anchor is a separate step**, applied in `refreshPricing` and `fetchPricing`
only. It cannot live inside `parseLitellmPricing`: the generator would then be
anchoring the snapshot to itself, which is circular and meaningless.

### `findPricing` tie-break (`cost-calculator.ts`)

First-match-wins becomes longest-key-wins, lexicographic on ties. Deterministic
regardless of key ordering. Every current model hits the exact-match branch
first, so live behaviour is unchanged; this removes the ordering dependency, not
a live miscalculation.

For the issue's example, `"claude-opus-4-5-20251101"` (24 chars) beats
`"claude-opus-4"` (13 chars) and the correct $5 price applies in either ordering.

### `readJsonValidated` in `src/utils/atomic-json.ts`

```ts
export function readJsonValidated<S extends v.GenericSchema>(
  filePath: string,
  schema: S,
): v.InferOutput<S> | null
```

Reads the file, `JSON.parse`s, `v.safeParse`s; returns `null` for a missing file,
bad JSON, or a schema failure. Callers treat `null` as "rebuild from scratch" —
the posture they already have for a missing file.

It lives in `atomic-json.ts` because that module already owns the write half;
this makes it the single read-validate-write owner #92 asks for. The file keeps
its name — renaming would be churn across five importers.

### Schemas, colocated with their owning module

| Module | Schema | Replaces |
|---|---|---|
| `cache/cache-manager.ts` | `output: string`, `timestamp: number`; `sessionId`/`costUsd`/`terminalWidth` optional | bare cast at `:28` |
| `data/turn-tracker.ts` | `sessionId: string`, `count: number` | bare cast at `:27` (the `null` crash) |
| `data/daily-cost-tracker.ts` | shard entry, plus the legacy migration file | hand-rolled `typeof` checks at `:87`, `:95`, `:96`, `:142`, `:155` |
| `cache/pricing-cache.ts` | `timestamp: number`, `data: record(string, unknown)` | `cache?.timestamp` check at `:34` |

Colocation keeps ownership local; only the read-validate mechanism is shared.

`v.fallback` preserves today's tolerances exactly — `baselineUsd` -> `0`, missing
`updatedAt` -> `0`, absent-or-invalid `source` -> `undefined` (treated as a
legacy file). No existing accounting behaviour changes.

Numbers arriving from JSON are always finite (JSON cannot encode `NaN` or
`Infinity`), so `v.number()` is sufficient at these boundaries.

### The one exception to whole-file discard

`pricing-cache.ts` validates its envelope with a schema but passes `data` through
`isSaneModelPricing` **per entry**, so a corrupted price drops one model rather
than the whole table.

The **anchor is deliberately not re-run on read.** The anchor is about trusting
the *feed*; the cached entries already passed it at write time. Re-applying it
would silently invalidate a legitimately-cached price on the day someone
regenerates the snapshot after a real price move. Bounds-on-read is what #92
actually asks for — the `NaN`/`undefined` guard.

## Testing

New `src/__tests__/cache-validation.test.ts`:

- Each of the four readers, fed a structurally-valid-but-wrong-typed file, plus
  the bare `null` case: asserts discard-and-rebuild, not a throw and not a
  corrupted value.
- A pipeline-level case asserting no `NaN` reaches rendered output. Hermetic per
  the house pattern (`pipeline.test.ts`): set both `HOME` and `XDG_CACHE_HOME` to
  a tmpdir, mock only `../data/pricing-fetcher.js`.

Extended:

- `pricing-fetcher.test.ts`: an absurd upstream table is rejected and the
  previous cache or fallback is used; a within-bounds-but-off-anchor entry is
  rejected while its table-mates survive.
- `cost-calculator.test.ts`: the same two keys inserted in both orders yield the
  same price (#91's acceptance criterion).

Every new test gets the mutation check from `vacuous-tests.md`: break the guard
it covers, confirm the test goes red, restore.

## Acceptance criteria

From #91: a malformed or absurd upstream table is rejected and the previous cache
or fallback is used; a test pins the fuzzy-match tie-break so key ordering cannot
change a price.

From #92: a test feeding each cache reader a structurally-valid-but-wrong-typed
file asserts the reader discards it and no `NaN` reaches the rendered output.

Plus: `turn-count.json` containing `null` renders a normal bar.

## Delivery

One PR closing both issues — they share `pricing-validation.ts`, the same way PR
#102 closed #82 + #93 together.

Commit step per `CLAUDE.md`: `npm run typecheck`, `npm run typecheck:scripts`,
`npm test`, then `npm run build` and `git add -f dist/index.js` in the same
commit. `AUDIT.md` is deliberately untracked and stays unstaged; its remediation
log is updated locally.
