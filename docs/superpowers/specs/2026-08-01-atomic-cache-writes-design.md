# Atomic, lost-update-safe cache writes

Design for issue #81 (REL-001, P1) — 2026-08-01, branch `fix/81-atomic-cache-writes`.

## Problem

Every cache file is written with a bare `fs.writeFileSync` after a read-modify-write,
with no lock and no temp+rename. Two concurrent renders both read the store, both
mutate their own copy, and the second write erases the first session's entry. The
erased entry is gone from the store, so `today-spend` — which ships in the default
layout — under-reports for the rest of the day. Nothing recomputes the store from
transcripts, so the loss is permanent.

The audit measured 4 of 8 rounds losing updates at 12 concurrent sessions, up to 25%
of the day's spend. Two Claude Code windows is a normal setup.

Affected write sites:

| File | Shape | Lost update costs |
|---|---|---|
| `src/data/daily-cost-tracker.ts:59` | cross-session accumulator | today's spend, permanently |
| `src/cache/cache-manager.ts:68` | single-entry cache | one recomputation |
| `src/cache/pricing-cache.ts:35` | single-entry cache | one refetch |
| `src/cache/block-cache.ts:37` | single-entry cache | one recomputation |
| `src/data/turn-tracker.ts:39` | per-session counter | one increment |

A torn write from the same race is also the mechanism that produces unparseable
cache files (SEC-002, #92).

## Approach

Tiered, because the five files do not have the same failure cost:

- **All five** get atomic replacement, which removes torn writes and the corruption
  path into #92.
- **Only the daily store** gets lost-update protection, and it gets it by removing the
  shared read-modify-write rather than by locking it.

Rejected alternatives:

- **`O_EXCL` lockfile around `daily-costs.json`** (the issue's own prescription). Smaller
  diff and no migration, but it puts a blocking lock on the render hot path, serialises
  every session through one file, and needs a stale-lock heuristic so a crashed holder
  is recoverable — a heuristic that is itself a bug source. At the acceptance
  criterion's N=50 it serialises 50 renders.
- **Optimistic compare-and-retry with no lock.** `rename` is not a compare-and-swap, so
  two processes can still interleave between verify and write. It narrows the race
  window instead of closing it.

## Storage model

`~/.cache/gccusage/daily/<key>.json`, one file per session:

```jsonc
{
  "sessionId": "…",      // as received, unsanitised, for debugging
  "date": "2026-08-01",  // LOCAL date (getFullYear/getMonth/getDate), as today
  "costUsd": 12.34,      // latest cumulative session cost
  "baselineUsd": 2.00,   // cumulative cost at the start of `date`
  "source": "stdin",     // "stdin" | "calculated"
  "updatedAt": 1754100000000
}
```

`date` moves from the file to the entry. That is what makes sharding work: a reader
can tell a stale shard from a live one without writing to it.

### Filename key

`sessionId` arrives from stdin and must never reach a path unchecked. Ids matching
`^[A-Za-z0-9_-]{1,128}$` — the UUIDs Claude Code actually sends — are used verbatim;
anything else becomes the first 16 hex chars of its sha256. Deterministic,
collision-free in practice, and `../../evil` cannot escape the cache directory.

### Read

`readdir` the shard directory, parse each file, skip unparseable ones, and sum:

```
entry.date === today ? max(0, entry.costUsd − entry.baselineUsd) : 0
```

Shards with `now − updatedAt >= STALE_SESSION_MS` (48h, unchanged) are unlinked in
passing. A missing directory reads as an empty store.

### Write

A render writes exactly one file — its own — via `writeJsonAtomic`. Every existing
accounting rule is preserved verbatim:

- new session → `baselineUsd: 0`
- cross-source switch → `baselineUsd = costUsd − accruedToday` (never fold; folding
  cross-source was the inflation bug of PR #34)
- same-source cost drop (restart) → `baselineUsd = −accruedToday`
- rollover (`entry.date !== today`) → `baselineUsd = costUsd`, `date = today`

The only behavioural change is that rollover happens per shard, lazily, on that
session's next write, instead of the reader rewriting every session's entry. The
totals are identical, because a shard whose `date` is not today contributes zero
either way. No process ever writes another session's data, which is why the lost
update cannot occur.

`trackDailyCost` keeps its signature and its contract, including being called only
when its return value is what the widget displays (issue #32 / PR #35).

### Migration

The first read after the upgrade splits an existing `daily-costs.json` into shards,
carrying that file's `date` onto each entry, then unlinks it. Two processes migrating
concurrently write byte-identical shards, so it is idempotent. Without migration
today's total resets to zero once on upgrade.

## `src/utils/atomic-json.ts`

One export:

```ts
export function writeJsonAtomic(filePath: string, data: unknown): void
```

`ensureDir` the parent, `writeFileSync` to `${filePath}.${process.pid}.${counter}.tmp`,
then `renameSync` onto the target; on failure, best-effort unlink of the tmp before
rethrowing. Tmp and target share a directory, so the rename is atomic and never
crosses a filesystem.

The pid+counter suffix is load-bearing: a fixed `.tmp` name lets two processes
interleave writes into the same temp file and rename the mixture into place, which
is the corruption this is meant to prevent.

The helper throws. Each call site keeps the error posture it already has — the four
caches swallow inside their existing `try`, `trackDailyCost` does not.

## The other four sites

`fs.writeFileSync` → `writeJsonAtomic`, no other change.

No locking for these. For the three caches a clobber costs one recomputation. For
`turn-count.json`, the file already resets whenever the session id changes, so a lost
increment across two concurrent sessions is indistinguishable from its designed
behaviour; this gets a comment at the call site rather than a lock. (#99 argues the
widget should not be running at all; that is out of scope here.)

## Testing

- `src/__tests__/atomic-json.test.ts` — writes readable JSON; replaces the whole of a
  longer existing file; creates a missing parent directory; leaves no `.tmp` sibling on
  success; and removes the temp file and rethrows when the rename fails (a directory at
  the target path), the one path that can leak one. The unique-tmp-name property is
  deliberately *not* asserted here: no single-process test can distinguish a unique name
  from a fixed one, since the failure needs two processes interleaving between write and
  rename. The spawn harness below covers it.
- `src/__tests__/daily-cost-tracker.test.ts` — extended for: shard layout, migration
  from a legacy `daily-costs.json`, per-shard rollover, 48h pruning, the traversal
  guard, and the design's core property — interleaving session A's read-mutate-write
  around session B's and asserting neither is lost. Existing accounting cases
  (restart fold, cross-source re-baseline) are retained. Test helpers must compute the
  local date, not `toISOString().slice(0,10)`, or they silently exercise the rollover
  path.
- `src/__tests__/pipeline.test.ts` — its `daily-costs.json` path helper moves to the
  shard directory.
- `scripts/concurrency-harness.ts` (`npm run harness:concurrency`) — the audit's own
  reproduction: N concurrent spawns of the shipped `dist/index.js` over R rounds against
  an isolated `XDG_CACHE_HOME`, asserting the exact expected total per round. It spawns
  the bundle rather than importing `src/` because `scripts/` cannot import `src/` (the
  `.js`-specifier trap).

  **The per-session cost must grow each round.** The first version of the harness sent a
  fixed $10 and reported 8/8 ok against the *unfixed* bundle — the statusline cache keys
  on (session, cost, width), so every round after the first was a cache hit that never
  reached the tracker. It measured nothing and printed success. With the cost stepping
  per round the same unfixed bundle fails 7/8, one round retaining 2 of 12 sessions.

### Acceptance

12 sessions × 8 rounds passes 8/8, and again at N=50, with the harness output quoted
in the PR.

Measured on this branch: the pre-fix bundle (`main` at d341c27) loses updates in 7 of 8
rounds at N=12; the fixed bundle is 0/8 at N=12 and 0/8 at N=50.

## Rollout

One PR off `fix/81-atomic-cache-writes`. `npm run build` runs and `dist/index.js` is
staged in the same commit as the `src/` change — a src-only commit leaves `git pull`
upgraders running the old bundle.
