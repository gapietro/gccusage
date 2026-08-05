# Derive the turn count from the transcript

**Issue:** #129 — `turnCount` counts statusline-cache misses, not turns
**Date:** 2026-08-04
**Supersedes the storage half of:** `2026-08-04-turn-tracker-gate-and-shard-design.md` (#99, PR #128)

## Problem

`turn-counter` renders `context.turnCount` with a default label of `#`, implying a
turn number. It has never been one.

`runStatusline` returns from the statusline cache before `buildRenderContext`
runs, and `trackTurn` is called from `buildRenderContext`. With the default 5s
TTL, a burst of renders inside one window increments the counter once. The
number shown is "renders that missed the statusline cache" — which tracks
neither turns nor renders.

Sharding the store (#99) did not change this. PR #128 documented the defect at
`src/data/turn-tracker.ts:111-113` rather than fixing it.

## What the transcripts actually contain

Measured across three real sessions before choosing a rule. Every `type: "user"`
entry was classified by `origin.kind` and `promptSource`:

| `origin.kind` | `promptSource` | kraken-bot (3564 lines) | gccusage A (1337) | gccusage B (1421) |
|---|---|---|---|---|
| `human` | `typed` / `suggestion_accepted` / `queued` | **28** | **18** | **23** |
| `task-notification` | `system` | 124 | 27 | 25 |
| *absent* — `tool_result` arrays and `isMeta` text | — | 784 | 293 | 314 |

Distinct assistant `message.id` groups in the same files: 624 / 293 / 317.

Two findings drove the design:

1. **The obvious reading of the issue over-counts by roughly 5x.** Counting
   `type: "user"` entries gives 152 on the kraken session, not 28 — both
   `<task-notification>` injections and tool results are `type: "user"`.
2. **A first-class discriminator exists,** so no string-sniffing of content
   wrappers is needed. `origin.kind === "human"` separates prompts from
   injections exactly, and `promptId` corroborates it: a prompt and all of its
   tool results share one.

A 400-file corpus sample confirms the vocabulary is small and stable:
`human` (1431), `task-notification` (1716), `coordinator` (25), absent (~31k).

## Decision

Count human prompts, not API responses. `#28` is what a reader of a statusline
means by a turn number; `#624` is a count of tool-use round-trips.

## Mechanism

**`src/data/jsonl-reader.ts`** — `normalizeEntry` carries one more field,
mirroring how it already unwraps `message.model`:

```ts
const origin =
  typeof raw["origin"] === "object" && raw["origin"] !== null
    ? (raw["origin"] as Record<string, unknown>)
    : undefined;
if (typeof origin?.["kind"] === "string") entry.originKind = origin["kind"];
```

`JsonlEntry` gains `originKind?: string`.

**`src/data/token-aggregator.ts`** — the rule lives beside `getFirstTimestamp`,
which is already a non-token scalar derived from the same array:

```ts
export function countHumanTurns(entries: JsonlEntry[]): number {
  let count = 0;
  for (const e of entries) if (e.type === "user" && e.originKind === "human") count++;
  return count;
}
```

**`src/data/pipeline.ts`** — line 144 collapses to
`turnCount: countHumanTurns(sessionEntries)`.

`sessionEntries` is already parsed at `pipeline.ts:43` for `aggregateTokens`, so
this adds no I/O. The count is recomputed per render rather than accumulated,
which is what makes it survive the statusline cache: a cache hit replays a bar
whose number was correct when written, instead of one that has drifted.

### Why the layout gate goes

The gate at `pipeline.ts:144` exists because `trackTurn` did file I/O for a
widget in no default layout. Filtering an in-memory array is free, so the gate
stops paying for itself. `turn-counter` is `layoutIncludesWidget`'s only caller
— `today` is gated on `settings.costSource` (`pipeline.ts:79`), not on layout —
so `src/config/layout.ts` becomes dead code with it.

### Sidechains

Subagent user entries carry `origin.kind` of `coordinator` or nothing, so
`=== "human"` excludes them without a separate `isSidechain` check. None of the
three sampled sessions contained sidechain entries; the implementation must
verify this against a transcript that does.

## Inventory

**Deleted**
- `src/data/turn-tracker.ts` (142 lines)
- `src/config/layout.ts` (16 lines)
- `src/__tests__/turn-tracker.test.ts`
- `src/__tests__/layout-gate.test.ts`

**Added**
- `countHumanTurns` in `token-aggregator.ts`, `originKind` in `jsonl-reader.ts` (~15 lines)
- A one-shot cleanup in `gccusage setup` (`src/cli.ts`)

**Modified**
- `src/data/pipeline.ts` — gate replaced by the derivation
- `src/__tests__/cache-validation.test.ts` — two tests retargeted (below)
- `src/__tests__/fixtures/widget-expectations.ts:104` — the `why` text explains
  sharded-tracker reasoning that will no longer exist
- `README.md:311` — "Conversation turn count (`#9`)" becomes true for the first time

Net: roughly −350 lines. The render path loses a read, a write, and a
conditional `readdir`.

## Disposing of the store

`trackTurn` owned both the 48-hour prune and the legacy-file unlink, so deleting
it strands whatever is on disk. On the development machine that is
`~/.cache/gccusage/turn-count.json` (62 B) plus five shards under
`~/.cache/gccusage/turns/`.

Cleanup goes in `gccusage setup` — off the render path, so it costs the
statusline nothing. Users who never re-run setup keep roughly 110 bytes of inert
files; adding an unconditional unlink back to every render is the per-render I/O
that #99 removed, and is not worth 110 bytes.

Every existing user has the legacy file, since the pre-#128 call was
unconditional. Only users who configured `turn-counter` have shards.

## Spun-off finding: Infinity in the daily store

Deleting `turn-tracker.ts` removes the repo's **only two uses of
`v.safeInteger()`**. Checking where the same shape appears elsewhere found a
live defect:

```
src/data/daily-cost-tracker.ts:33    updatedAt: v.fallback(v.number(), 0),
src/data/daily-cost-tracker.ts:173   if (now.getTime() - entry.updatedAt >= STALE_SESSION_MS) {
```

This is the second failure mode `turn-tracker.ts:15-18` documents. A shard
containing `"updatedAt": 1e400` parses to `Infinity`; `v.number()` accepts it;
`now - Infinity` is `-Infinity`, which is never `>= STALE_SESSION_MS`. The shard
is unpruneable forever. The hardening was applied to the turn store and never
carried across to the daily store — which, unlike the turn store, is in the
default layout.

**Disposition:** filed as its own issue crediting this design pass, and fixed in
this PR, because the test that proves it is being retargeted here anyway. The
fix is `updatedAt: v.fallback(v.pipe(v.number(), v.safeInteger()), 0)`.

## Testing

**Retargeted, not deleted.** `cache-validation.test.ts:542` ("rejects an
Infinity turn count instead of rendering it") loses its subject with the turn
store. It is pointed at `daily-cost-tracker` instead, where it is expected to
fail until the fix above lands. Its companion at `:449` already corrupts the
statusline cache and a daily shard alongside the turn shard, so it survives by
dropping its third vehicle.

**New coverage for `countHumanTurns`:**

- counts entries with `origin.kind === "human"`
- excludes `tool_result` content arrays, `task-notification`, `isMeta` entries,
  and `coordinator` sidechain entries
- returns `0` when `origin` is absent from every entry

**The regression test for #129 itself:** two `buildRenderContext` calls inside
the statusline TTL must yield the same count. Under the old code the second call
returned an incremented number. Per the repo's vacuous-tests discipline, this
test is verified by reconstructing the old `trackTurn` and confirming it goes
red.

Fixtures are built from the entry shapes measured above, not hand-invented JSON.

## Degradation

If a transcript predates the `origin` field, the filter yields `0` and
`turn-counter.ts:8`'s `!count || count < 1` guard renders nothing. Showing
nothing beats showing a wrong number, and this was accepted explicitly.

This is **inferred from the guard, not observed** — no transcript on the
development machine predates 2026-04-01, so the pre-`origin` format could not be
tested. Recorded here as a known gap rather than a verified behaviour.

## Acceptance criteria

From #129: the displayed number equals the session's real turn count regardless
of statusline cache hits.

Concretely:

1. `turnCount` is derived from `sessionEntries` and never persisted.
2. Repeated renders inside the statusline TTL do not change it.
3. `src/data/turn-tracker.ts` and `src/config/layout.ts` no longer exist.
4. `gccusage setup` removes `turns/` and `turn-count.json`.
5. `daily-cost-tracker`'s `updatedAt` rejects `Infinity`, with a test that fails
   without the fix.
6. `npm run build` is run and `dist/index.js` staged in the same commit — a
   src-only commit leaves `git pull` upgraders on the old code, and CI's
   `bundle-drift` job enforces byte-equality.
