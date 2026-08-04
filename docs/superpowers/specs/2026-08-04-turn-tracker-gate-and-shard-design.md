# Gate and shard the turn tracker (#99)

Date: 2026-08-04
Issue: [#99](https://github.com/gapietro/gccusage/issues/99) (audit CLEAN-002)

## Problem

`buildRenderContext` calls `trackTurn(stdin.session_id)` unconditionally
(`src/data/pipeline.ts:139`). `trackTurn` reads, parses, mutates and writes
`~/.cache/gccusage/turn-count.json` every time. Its only consumer is the
`turn-counter` widget, which appears in no layout in `src/config/defaults.ts`.

The issue names two defects:

1. **The I/O** — a read and a write for a value almost nobody displays.
2. **The single global slot** — one `{sessionId, count}` for the whole machine,
   so two concurrent sessions reset each other to 1 on alternating renders.
   The counter is wrong under exactly the conditions that make it interesting.

Same defect class as REL-001 (#81), which sharded the daily cost store per
session for this reason. That fix is the template for the second half here.

### Correction to the issue's framing: this is per *cache miss*, not per render

`runStatusline` checks the statusline cache and returns before
`buildRenderContext` runs (`src/statusline.ts:26-29`). On a cache hit
`trackTurn` never executes. With the default 5s TTL, a burst of renders inside
one window increments the counter once.

Two consequences:

- The I/O saving is real but smaller than "every render" — it is one read plus
  one write per cache miss.
- **`turnCount` has never counted turns.** It counts cache misses. The widget's
  default `#` label promises a turn number the code has never produced.

This matters for the design because gating on layout presence is not a
semantic regression to an otherwise-correct counter. The counter is already
approximate, and both changes below preserve its existing meaning exactly.

### Measured scale of the sharding concern

On this machine, at the time of writing:

| Observation | Value |
|---|---|
| `turn-count.json` contents | `{"sessionId":"f824ed55-…","count":1}` |
| Live daily shards (48h window) | 66 |
| Transcripts on disk (all time) | 1,620 |

66 sessions active inside one 48h window is the concurrency that thrashes a
single global slot. The 1,620 figure sizes the *other* risk: sharding without
pruning grows one file per session forever.

## Goals

- A render whose layout has no `turn-counter` performs no read or write of the
  turn store. (The issue's stated acceptance criterion.)
- Concurrent sessions no longer reset each other's counts.
- The turn store stays bounded without adding a directory scan to every render.

## Non-goals

- **Making the counter count turns.** Deferred deliberately. Deriving a true
  turn count from `sessionEntries` (already parsed in `buildRenderContext`) or
  relabelling the widget are both viable, and both are larger than this issue.
  To be filed as a follow-up.
- Migrating the legacy `turn-count.json` value. See Decisions.
- Consolidating the repo's five cache-persistence blocks (#100).

## Design

### 1. Gate the call

New `src/config/layout.ts`:

```ts
export function layoutIncludesWidget(settings: Settings, type: string): boolean
```

Scans `settings.lines[].widgets[].type`. `lines` is always present after the
loader merge (`src/config/loader.ts:40`), so no optional handling is needed.

Call site in `pipeline.ts`, mirroring the `today` gate directly above it:

```ts
turnCount: layoutIncludesWidget(settings, "turn-counter")
  ? trackTurn(stdin.session_id)
  : 0,
```

`0` is a safe sentinel: `turn-counter` already returns `null` for
`!count || count < 1`, so a gated render cannot display a false zero.

The gate is deliberately coarse — it asks whether the widget is *configured*,
not whether it survives compaction or shrinking at render time. A widget
dropped by the shrink pass still increments. Over-counting in that edge is
acceptable; the objective is to charge nothing to the users who never asked
for the widget at all.

### 2. Shard per session

`turn-count.json` becomes `turns/<key>.json` holding
`{sessionId, count, updatedAt}`, validated on read by a valibot schema as the
current file already is (#92 — a `null` file must not blank the bar).

`sessionId` stays *inside* the file even though the key derives from it, so a
hash collision is detected by the existing "reset when the session differs"
guard rather than silently continuing another session's count.

Key derivation is the `SAFE_SESSION_ID` regex plus sha256 fallback that
`daily-cost-tracker.ts` already uses. Rather than copy it, extract it to
`src/utils/paths.ts` as a shared `shardKey(sessionId)` and have both callers
use it. Untrusted stdin reaching a filesystem path should have exactly one
implementation.

Unlike the daily store, the turn tracker needs only its **own** shard — there
is no cross-session total to compute — so steady-state cost is one read and one
write of one small file, with no `readdir`.

### 3. Prune without a per-render scan

Sharding introduces unbounded growth. The daily store prunes during the
full-directory read it already performs; the turn tracker has no such read and
adding one per render would trade one defect for another.

Prune instead only when our own shard does **not** yet exist — the first render
of a session, once per session rather than once per render.

Concretely: the read of our own shard already happens, and `readJsonValidated`
returns `null` when the file is missing. A `null` result therefore triggers the
sweep — no extra `stat`. A corrupt shard also reads as `null` and so also
triggers a sweep; that is harmless, since the sweep only removes files that are
independently stale.

The sweep:

- removes shards whose `updatedAt` is older than 48h, and
- unlinks the legacy `turn-count.json` if present, so the old global file does
  not linger as orphaned litter.

The 48h threshold is defined locally in `turn-tracker.ts` rather than imported
from `daily-cost-tracker.ts`. The two stores agree on the number today but
their retention policies are independent, and sharing the constant would couple
them into moving together for no reason.

Pruning is best effort throughout: an `unlink` failure is swallowed, exactly as
in `daily-cost-tracker.ts`, since a stale shard contributes nothing.

## Decisions

**No migration of the legacy value.** The daily store migrated (#81) because
losing it reset a user's visible daily spend. Here the legacy file holds one
global count, for one session, for a widget in no default layout, and the
counter is designed to reset on session change anyway. Carrying it forward
would add a permanent code path to preserve a number that is already
approximate. The file is deleted rather than read.

**Gate on the layout, not on a resolved flag.** The `today` gate above it keys
on the `costSource` *setting* because the resolved source diverges from it
(#94). No such divergence exists here: layout presence is the whole condition.

## Testing

Every test below is verified by breaking what it guards, per the repo's
vacuous-test discipline.

- **Gate** — layout without `turn-counter`: no file appears under the turns
  dir and `turnCount === 0`. Layout with it: the shard is written and the count
  increments across calls.
- **Shard (the regression test)** — two session ids interleaved; each retains
  its own count. **Verified by rebuilding the pre-fix single-file tracker and
  confirming this test fails against it**, following the method used for
  `concurrency.test.ts`. A sharding test that passes against unsharded code
  asserts nothing.
- **Prune** — a shard with `updatedAt` older than 48h is removed on a new
  session's first render; a fresh shard survives; a legacy `turn-count.json` is
  unlinked.
- **Path safety** — a session id of `../../etc/passwd` hashes to a filename
  that stays inside the turns dir.
- **Migrated assertions** — the existing `trackTurn` cases in
  `cache-validation.test.ts:107-125`, including the #92 `null`-file case, move
  to the new store path.

Hermetic setup follows `pipeline.test.ts`: set both `HOME` and
`XDG_CACHE_HOME` to a tmpdir.

`src/__tests__/fixtures/context-from-fixture.ts:52` sets `turnCount` literally
from `controlled.turnCount`, so the widget reality harness does not route
through `buildRenderContext` and is unaffected. To be confirmed during
implementation rather than assumed.

## Shipping

`npm run build` with `git add -f dist/index.js` in the same commit. CI's
`bundle-drift` job enforces byte-equality, and a src-only commit leaves
`git pull` upgraders running the old bundle.

## Known verification gap

GitHub Actions has been failing account-wide since before PR #114 — every job
aborts in seconds with a billing error, having executed zero steps. All four
jobs will be hand-run on a clean clone and again on merged `main`, which
catches real regressions but **cannot cover Node 22 or 24**: this machine has
only Node 25/26 and no version manager. That debt is unchanged by this work and
retires only when real CI runs.
