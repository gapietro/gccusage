# Auto-compact threshold: replace the 16.5% estimate with the derived rule

**Date:** 2026-07-31
**Issue:** [#37](https://github.com/gapietro/gccusage/issues/37)
**Status:** approved, ready for planning

## Problem

`compact-countdown` predicts auto-compact with a guessed constant:

```ts
const AUTOCOMPACT_THRESHOLD = 1 - 0.165;  // 83.5% of the window
```

Issue #37 asked for this to be settled by running a session to compaction at
each window size. It has now been settled a different way, and the answer
invalidates the shape of the constant, not just its value.

## What the rule actually is

Extracted from the shipped Claude Code binary
(`~/.local/share/claude/versions/2.1.220`, `VERSION: "2.1.220"`,
`BUILD_TIME: 2026-07-24`). The relevant functions, de-minified:

```js
aY(model, setting)  -> { window }              // min(model max context, configured autoCompactWindow)
CSe(model, setting) = aY(...).window - Math.min(maxOutputTokens, 20000)
Sfo(eff)            = eff - 13000              // the compact threshold
uMu(tokens, eff)    = tokens >= Sfo(eff) ? "compact" : ...
```

`cst()` gives a default `max_output_tokens` of 32000 (`$Rg = 32000`), so
`Math.min(maxOutputTokens, 20000)` always clamps to 20000 for current models.
Therefore:

> **Auto-compact fires at `windowSize − 33,000` tokens.**
> It is a fixed token reserve, not a percentage of the window.

| Window | True threshold | As a % | Old 83.5% assumption | Error |
|--------|---------------:|-------:|---------------------:|------:|
| 200k   | 167,000        | 83.5%  | 167,000              | exact |
| 1M     | 967,000        | 96.7%  | 835,000              | 132,000 tokens early |

The old constant was exactly right at 200k and badly wrong at 1M — which is
why it survived review. Corroboration from inside the same binary: its
precompute table hardcodes `"claude-sonnet-5": { default: 967000 }`, which is
`1,000,000 − 33,000`.

### Two further facts from the same source

- **Claude Code's own warn level** is `threshold − 20,000` (`uMu`'s
  `s = i - 20000`). We adopt that number rather than inventing one.
- **`used_percentage` is an integer** and excludes `output_tokens`
  (`mro()` sums `input + cache_creation + cache_read`, then `Math.round`).
  The compaction check *includes* output (`dIe()`). At a 1M window one
  percentage point is 10,000 tokens — against a 33,000-token budget, that is
  up to ±5,000 tokens of error in a "~Nk left" readout.

### What stdin does and does not tell us

`context_window_size` is `JE(model, ...)` — the **model max context**. It is
not `aY().window`, so it does not reflect a configured `autoCompactWindow`.
Neither `autoCompactWindow` nor `autoCompactEnabled` appears in the statusline
payload. Both are accepted as documented limitations (see below).

## Design

### 1. New module: `src/utils/autocompact.ts`

One home for the rule, so no widget hardcodes it.

```ts
/** Claude Code reserves output headroom before compacting: min(maxOutputTokens, 20_000). */
const OUTPUT_RESERVE = 20_000;
/** Plus a fixed compaction reserve on top. */
const COMPACT_RESERVE = 13_000;
export const AUTOCOMPACT_RESERVE = OUTPUT_RESERVE + COMPACT_RESERVE; // 33_000

/** Amber band: Claude Code's own "warn" level, threshold - 20k. */
export const AMBER_TOKENS = 20_000;
/** Red band: last warning before compaction. */
export const RED_TOKENS = 5_000;

/** Tokens at which auto-compact fires; null when the window is too small to model. */
export function compactThresholdTokens(windowSize: number): number | null;

/** Tokens remaining before that point; null when the threshold is unmodellable. */
export function tokensUntilCompact(usedTokens: number, windowSize: number): number | null;
```

`compactThresholdTokens` returns `null` when `windowSize <= AUTOCOMPACT_RESERVE`.
A window that small cannot be modelled, and callers fall back rather than render
a negative or nonsensical countdown.

The module's doc comment cites `Sfo` / `CSe` / `uMu` / `mro` in Claude Code
2.1.220 and the corroborating `967000` literal, so a future reader can
re-derive the constants against a newer version instead of trusting this file.

### 2. `deriveContextUsage` gains `usedTokens`

```ts
export interface ContextUsage {
  ratio: number;
  windowSize: number | null;
  usedTokens: number | null;  // new
}
```

`ratio` keeps its current derivation **unchanged** — reported percentage first.
That is what makes our displayed `%` match Claude Code's own `/context` output,
and changing it is out of scope.

`usedTokens` resolves in this order:

1. `sumTokens(current_usage)` when `current_usage` is present — exact, and
   matches what Claude Code's `dIe()` sums (input + cache_creation +
   cache_read + output).
2. `Math.round(ratio * windowSize)` when a window size is known.
3. `null`.

These two fields can disagree by a fraction of a percent, because `ratio` is
sourced from a figure that excludes output tokens while `usedTokens` includes
them. That is intentional: each is right for its own job. The divergence is
bounded by one turn's output tokens.

### 3. `compact-countdown`

Delete `AUTOCOMPACT_THRESHOLD`, `HEADROOM_DANGER`, `HEADROOM_WARN`.

```
remaining = tokensUntilCompact(usedTokens, windowSize)

remaining === null  -> render null (unchanged behaviour for unknown windows)
remaining <= 0      -> "Compact imminent!"   #ffffff on #a01822
remaining <= 5_000  -> "~Nk left"            on #a01822
remaining <= 20_000 -> "~Nk left"            on #b8860b
otherwise           -> "~Nk left"            on config.bg
```

Also returns null when `usedTokens` is null.

### 4. `context-percent`

`thresholdBg` moves to token space using the same two constants: red at
`remaining <= 5_000`, amber at `remaining <= 20_000`. The existing 70% / 90%
percentage thresholds remain as the fallback path for when `windowSize` or
`usedTokens` is unavailable. The bar, the `%` text, and the window-size suffix
are untouched.

Resulting alignment:

| Window | Amber at | Red at | Compact at |
|--------|---------:|-------:|-----------:|
| 200k   | 73.5%    | 81.0%  | 83.5%      |
| 1M     | 94.7%    | 96.2%  | 96.7%      |

Both widgets now change colour on the same turn at any window size, and
`context-percent`'s red is reachable again — it previously sat at 90%, above
the 200k compaction point, so a 200k session compacted before it could ever
turn red.

### 5. Adjacency

`context-percent` and `compact-countdown` are neighbours on line 1 of the
default layout. This design makes them change colour on the same turn **by
construction** — a collision that used to be incidental is now guaranteed.

They keep their deliberately-distinct palettes (`#b8860b` / `#a01822` versus
`#a67c00` / `#c01c28`), and the ΔE-8 thin separator from PRs #39 / #41 is the
backstop when two backgrounds are perceptually close.

Per this repo's own history, the guard for this must **render** the bar at each
band boundary rather than inspect configured colours — a config-reading test
passes while the shipped bar merges, because both widgets override `bg` at
render time. CIEDE2000 values are not to be self-verified; the assertion is on
rendered output.

### 6. Known limitations (documented, not handled)

- **`autoCompactWindow`** (Claude Code setting, or
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) shrinks the window, so compaction fires
  earlier than we predict. Not visible in the statusline payload.
- **`autoCompactEnabled: false`** means compaction never fires, so
  "Compact imminent!" would be a lie.

Neither is set by default. Both get a note in the README and a comment in
`autocompact.ts`. Reading another tool's settings file to second-guess our own
input is coupling we would then have to maintain; revisit if anyone hits it.

## Testing

- Table-driven unit tests on `autocompact.ts` at 200k and 1M, asserting the
  threshold and all three band boundaries.
- Boundary tests at exactly 20,000 and exactly 5,000 remaining (inclusive
  comparisons).
- `windowSize <= 33_000` returns null; both widgets fall back cleanly.
- `deriveContextUsage`: exact-token path, `ratio × windowSize` fallback path,
  and null path.
- Render-level adjacency sweep across the band boundaries for line 1 of the
  default layout, asserting on rendered output.

## Out of scope

- A settings key for the reserve. The rule is now known exactly; a config
  override would re-introduce the guesswork this change removes.
- Reading Claude Code's `settings.json`.
- Changing how `ratio` is derived.

## Delivery

Every commit touching `src/` runs `npm run build` and stages the bundle with
`git add -f dist/index.js` — `gccusage setup` points `statusLine.command` at
`dist/index.js`, so a src-only commit leaves `git pull` upgraders running the
old code. Closes #37.
