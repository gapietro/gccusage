# Token accounting: parser dedup and burn-rate semantics

**Issues:** #52, #53 · **Date:** 2026-07-31 · **Status:** approved, not yet implemented

## Purpose

Two shipped defects make gccusage display numbers that are wrong rather than
absent. Both were found during #49 (PR #51), which fixed the same class of bug
in `scripts/` but deliberately left `src/` alone.

1. **#52** — `parseJsonlContent` counts one entry per JSONL line, but Claude
   Code writes one line per content block and repeats an identical
   `message.usage` on each. Token sums inflate ~2.12×, non-uniformly.
2. **#53** — `burn-rate` displays a tokens-per-minute figure derived from
   `context_window.total_input_tokens`, which is a snapshot of the last
   assistant message, not a session total. It divides a window size by a
   session duration.

Both touch `src/`, so each commit must `npm run build` and stage
`dist/index.js`. A `src/`-only commit leaves `git pull` upgraders on the old
bundle.

## #52 — dedup on `message.id`

### Evidence

Measured across the local corpus (92 main transcripts):

- 21,929 usage-bearing assistant lines against 10,368 distinct `message.id`
  groups — a **2.12× inflation**
- 6,156 groups span more than one line; in **6,156 of 6,156** the usage
  objects are byte-identical
- A representative group has block types `[thinking]`, `[text]`, `[tool_use]`,
  all three reporting the same `{input_tokens: 2, output_tokens: 296,
  cache_read: 20233, cache_creation: 17991}`

### Change

`parseJsonlContent` (`src/data/jsonl-reader.ts:28-41`) tracks a
`Set<string>` of seen `message.id` values and skips a line whose id was
already recorded.

The gate matches the merged reference in `scripts/lib/parse.ts`: skip only
when the line **has a `message.id`**, **carries usage**, and that id has been
seen. Three consequences of that precise gate:

- Records with **no** `message.id` stay separate entries. The legacy flat
  transcript format has no `message` wrapper, so legacy entries are never
  deduped — which is correct, since that format was never split across lines.
- Lines carrying no usage contribute nothing to token sums and are left
  alone, so nothing that reads `costUsd`, `timestamp` or `sessionId` changes
  behaviour.
- `normalizeEntry` is unchanged. The id is read from the raw parsed object
  inside `parseJsonlContent`; `JsonlEntry` does not gain a field, because
  nothing downstream needs one.

### Impact to expect

`gccusage today` and the `calculated` cost source both drop. `pipeline.ts:72`
takes the JSONL path when `costSource === "calculated"` **or** when
`stdinCost` is undefined, so the normal fallback is affected too, not only
forced-calculated mode. A lower number after this lands is the defect being
removed.

## #53 — burn-rate shows cost per hour

### What is actually wrong

`BurnRate` has three fields. **Only `tokensPerMinute` is rendered**
(`src/widgets/burn-rate.ts:12-13`); `costPerHour` and `costPerMinute` are
computed by both producers and consumed by nothing. The displayed field is
wrong on both paths, and the correct fields are dead:

| Path | `tokensPerMinute` derived from | Wrong because |
| --- | --- | --- |
| `getStdinBurnRate` (`pipeline.ts:18-40`) | `total_input_tokens + total_output_tokens` | Both are the latest assistant message's usage, so this is a window size over a session duration |
| `calculateBurnRate` (`cost-calculator.ts:54-88`) | summed JSONL `TokenMetrics` | Genuinely cumulative, but inflated ~2.12× by #52 |

### Change

`tokensPerMinute` is removed from the `BurnRate` interface
(`src/types/burn-rate.ts`). Both producers stop computing a token sum;
`getStdinBurnRate` keeps `total_cost_usd / total_duration_ms` and
`calculateBurnRate` keeps its JSONL-priced `costPerMinute`. The widget
renders `costPerHour` through a new `formatCostPerHour` in
`src/utils/format.ts`, following the existing `formatDollars` style.

### Why cost per hour rather than a corrected token rate

`tokensPerMinute` sums cache reads, so it is dominated by context size. That
makes it a restatement of "long session, large context" — the quantity #49
ruled out as non-actionable, and one `context-percent` and
`compact-countdown` already display against real thresholds. Cost per hour is
the number a user can act on, and it is already correct from stdin alone.

### Deliberate non-changes

- **No alert thresholds.** A threshold-coloured segment creates the dynamic
  adjacencies a static config check cannot see (#36, #40), and there is no
  established danger level for a spend rate. The widget keeps its static
  `#555555`.
- **No change to the null path.** `getStdinBurnRate` returns null below 10s
  or without cost data; the segment disappears, as now.
- **The two issues decouple.** Deleting the token sum means burn-rate no
  longer depends on #52 at all. #52 remains necessary for `gccusage today`.

## Testing

- A parser test asserting the transcript shape directly: two lines sharing
  one `message.id` with identical usage produce one entry. This is the third
  time a transcript-shape assumption has produced plausible-but-wrong figures
  (PR #29's nested-usage bug, PR #51's line-counting bug), so the shape gets
  pinned rather than inferred.
- A parser test that two entries with **no** `message.id` stay separate.
- `formatCostPerHour` unit tests at the boundaries `formatDollars` switches
  on.
- `src/__tests__/defaults.test.ts:109` builds a `burnRate` fixture literal
  containing `tokensPerMinute`. It is a fixture, not an assertion about the
  rate — drop the field and leave the test's intent alone.

`formatTokensPerMinute` (`src/utils/format.ts:47-51`) has exactly one
non-test consumer, the burn-rate widget. Once that switches, the function is
reachable only from its own tests. Delete it and its `format.test.ts` block
rather than leaving a formatter that formats nothing — a tested-but-unused
helper is the shape that made `separatorThin` dead config for months.

## Done means

- `npm test`, `npm run typecheck`, `npm run typecheck:scripts` all pass.
- `dist/index.js` is rebuilt and staged in every commit touching `src/`.
- The bar renders a cost rate where it rendered `tok/m`, verified by piping a
  real payload through the built bundle rather than only by unit test.
- `grep -rn "tokensPerMinute" src` returns nothing, and so does
  `grep -rn "formatTokensPerMinute" src`.

## Out of scope

- #54 (`getClaudeDataDir` HOME fallback) — same class as a bug fixed in
  `scripts/`, but independent of these two.
- #55 (docs snippet) — no `src/` change.
- Whether `today-spend` should show a corrected historical series. The daily
  store keeps recorded totals; this change alters future records only.
