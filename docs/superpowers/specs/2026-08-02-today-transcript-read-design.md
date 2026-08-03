# Stop re-reading today's transcripts on every cache miss (#94)

Issue: [#94](https://github.com/gapietro/gccusage/issues/94) (audit finding `PERF-001`, P2)

## Problem

`buildRenderContext` calls `findTodayJsonlFiles()` and fully parses every returned
transcript on every statusline cache miss. Measured on the author's real corpus on
2026-08-02:

```
all transcripts:   140 files, 222.0 MB
today (by mtime):   23 files,  33.2 MB
read + JSON.parse:  80 ms for 13,964 lines
```

Miss is the common case during active work, because the statusline cache key includes
the cumulative session cost, which changes every assistant turn. The cost grows with
the day's accumulated transcript volume and resets at midnight.

## The finding the issue missed

In the shipped default configuration that entire read is **dead work**. `todayEntries`
feeds exactly two things:

- `metrics.today` — one consumer in the whole repository, `src/cli.ts:51`, and `cli.ts`
  never calls `buildRenderContext`. In the render path it is written and never read.
  No widget touches it.
- `calculatedTodayCost` — used only inside the `settings.costSource === "calculated"`
  branch (`src/data/pipeline.ts:79-82`). The default is `"auto"`, where today's spend
  comes from the daily store via `trackDailyCost`.

So with `costSource` at `"auto"` or `"stdin"`, gccusage reads and parses 33 MB per cache
miss to compute two values it then discards.

The issue's own suggested fixes (incremental offsets, mtime skip, dedupe the double
aggregation) all optimise a computation that mostly should not run at all.

## Design

### 1. Read today's transcripts only when they are used

`buildRenderContext` performs the today read only when `settings.costSource ===
"calculated"`. In every other configuration neither the `findTodayJsonlFiles()` stat
sweep (140 `statSync` calls) nor the 33 MB parse happens.

The gate is the **setting**, not the resolved `sessionCostSource`. `"auto"` with no
stdin cost resolves the *session* source to `"calculated"` at `pipeline.ts:63` while
still taking today's spend from the daily store at `pipeline.ts:79`. Gating on the
resolved source would wrongly re-enable the read in that case.

### 2. `aggregateTokens` takes a single entries array

```ts
// before
aggregateTokens(sessionEntries: JsonlEntry[], todayEntries: JsonlEntry[]): AggregatedMetrics
interface AggregatedMetrics { byModel; session; today }

// after
aggregateTokens(entries: JsonlEntry[]): AggregatedMetrics
interface AggregatedMetrics { byModel; totals }
```

`today` is removed rather than left to read zero in the default config. A field that
silently returns 0 is the same "registered but never exercised" shape that let the
`compact-countdown` defect survive; a future widget wanting today's tokens must add the
plumbing deliberately.

The pipeline calls `aggregateTokens` once for session entries and, in calculated mode
only, once for today's. That also removes the double aggregation the issue flags
(`pipeline.ts:45` and `:56`). `cli.ts` composes its report from one call.

Blast radius: 7 files, 5 fixture sites.

### 3. Per-file aggregate cache for the calculated path

New module `src/cache/today-aggregate-cache.ts`, backed by
`<cacheDir>/today-aggregates.json`:

```jsonc
{
  "date": "2026-08-02",              // local date, YYYY-MM-DD
  "files": {
    "<absolute path>": { "mtimeMs": 0, "size": 0, "byModel": {}, "totals": {} }
  }
}
```

Per render (calculated mode only):

1. List today's files, capturing `mtimeMs` and `size` from the stat already performed by
   the path walk — no second `statSync`. `src/utils/paths.ts` gains
   `findTodayJsonlFileStats(): { path, mtimeMs, size }[]`, and the existing
   `findTodayJsonlFiles()` becomes a `.map(f => f.path)` over it, so `cli.ts` and the
   current tests keep their signature.
2. Load and validate the cache. A `date` that is not today's local date discards the
   whole thing; that is the midnight reset.
3. For each file, reuse the cached aggregate when **both** `mtimeMs` and `size` match
   exactly. Otherwise parse that one file, filter to today, aggregate, and store.
4. Rebuild the `files` map from the current file list, so files that dropped out of
   today's window prune themselves.
5. Write back atomically only when something changed.
6. Return the merged `{ byModel, totals, fileCount }`.

Cost when nothing changed: one small JSON read. Cost when the active transcript grew:
one file re-parsed.

**Whole-file re-parse on change, not byte-offset resume.** `parseJsonlContent` merges
lines sharing a `message.id`, so a group straddling an offset boundary would require
carrying the id→index map across renders. The only file that changes mid-day is the
active transcript; re-parsing it whole costs a few ms and is still flat with respect to
*day* volume. The extra persistent state is not worth it.

**Store `totals` alongside `byModel`.** Entries that carry usage but no `model` count
toward totals and not toward `byModel`, so `byModel` alone cannot reproduce
`gccusage today`'s "Total Tokens" line. Storing both lets `cli.ts` share the cache with
byte-identical output.

**Correctness of per-file aggregation.** The current code is
`filterTodayEntries(todayFiles.flatMap(parseJsonlFile))`, which already parses each file
independently, so `message.id` grouping never spans files. Filtering after concatenation
equals filtering per file then concatenating, and `byModel`/`totals` are additive.
Per-file aggregation is therefore exactly equivalent, not an approximation.

### Error handling and concurrency

- `readJsonValidated` + a valibot schema on read, `writeJsonAtomic` on write, matching
  `src/cache/block-cache.ts`.
- Whole-file discard on validation failure is correct here, unlike the daily store: this
  cache is fully recomputable, so discarding costs one slow render and never loses data.
- A write failure is swallowed; the next render recomputes.
- **Safety invariant:** a cached entry is reused only after `(mtimeMs, size)` re-verify
  against the live file, and the returned value is always assembled in-memory from that
  verified set. Concurrent statuslines racing on the write can therefore cost an extra
  re-parse on a later render, but can never produce a wrong total. Same no-lock posture
  as the daily cost store.
- Append-only JSONL always changes `size`, so a same-tick append cannot be mistaken for
  an unchanged file.

## Testing

- **The fix itself:** hermetic pipeline test (tmpdir `HOME` + `XDG_CACHE_HOME`) with a
  `readFileSync` spy. Under `costSource: "auto"`, another session's today-transcript
  never appears among the paths read. Reverting the gate must fail this test.
- **Equivalence:** cached totals identical to the uncached computation, over a corpus
  mixing today and yesterday entries, multiple models, and usage entries with no model.
- **Cache behaviour:** unchanged files produce zero transcript reads on a second call;
  an append re-reads exactly one file; date rollover invalidates; a corrupt cache file
  falls back to a correct full recompute; a file that leaves today's window is pruned.
- **Acceptance criterion:** CI asserts *bytes read* is flat between a small corpus and a
  10× corpus — deterministic, where a wall-clock assertion would be flaky. The literal
  35 MB / 350 MB timing from the issue is measured locally and reported in the PR body.
- Every new test is sabotage-checked by breaking what it guards, per the repository's
  vacuous-test rule.

## Acceptance criteria

- Cache-miss render time is flat with respect to the day's accumulated transcript
  volume, in both the default and `costSource: "calculated"` configurations.
- `gccusage today` output is unchanged.
- The commit includes the rebuilt `dist/index.js` (`git add -f`), which CI's
  `bundle-drift` job enforces.
