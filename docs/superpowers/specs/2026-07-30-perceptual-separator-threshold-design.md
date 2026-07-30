# Perceptual separator threshold

**Issue:** [#40](https://github.com/gapietro/gccusage/issues/40) — Adjacent separators are near-invisible at low contrast; the guard only catches exact bg equality
**Builds on:** [PR #39](https://github.com/gapietro/gccusage/pull/39) (issue #36) — must merge first
**Date:** 2026-07-30

## Problem

PR #39 made the powerline separator visible when two adjacent segments resolve to the
**identical** background: the wide `▶` is painted in the previous segment's `bg` over the
incoming segment's `bg`, so identical neighbours made it vanish. That case now draws the
thin `│` separator in the previous segment's foreground instead.

The invariant it encodes is exact equality, not visibility. Backgrounds a few perceptual
steps apart produce a separator that is drawn and still effectively invisible, and nothing
detects it — not `layoutPowerline`, and not the sweep in `src/__tests__/defaults.test.ts`,
which asserts `normalizeColor(fg) !== normalizeColor(bg)`.

Two such pairs are reachable in the shipped defaults, both created by `compact-countdown`'s
bespoke alert shades sitting next to `context-percent`'s:

| state | context-percent | compact-countdown | ΔE2000 |
|---|---|---|---|
| both warning (usage 70–75.1%) | `#a67c00` | `#b8860b` | **4.61** |
| both danger (usage ≥ 90%) | `#c01c28` | `#a01822` | **6.54** |

The second is not transient: once a session passes 90% context usage it stays there, so
that seam is low-contrast for the rest of the session.

## Correction: WCAG contrast is the wrong metric

Issue #40 as originally filed measured these boundaries with the **WCAG relative-luminance
contrast ratio** and concluded that 4 of 8 boundaries in the default healthy bar were
affected, the worst being `git-changes` ▶ `lines-changed` at 1.051:1.

That analysis is wrong and the issue body must be corrected. WCAG contrast measures
luminance only. It is designed for text legibility against a background, where luminance
dominates. It is not a measure of whether two adjacent color patches are distinguishable —
two colors can differ enormously in hue and score ~1.0.

`git-changes` `#7d4fa8` (purple) beside `lines-changed` `#0d7377` (teal) scores 1.051 by
WCAG and **32.21** by ΔE2000: one of the most distinguishable boundaries in the bar, not
the worst. Measuring both metrics over the same pairs:

| boundary | WCAG | ΔE2000 |
|---|---|---|
| `git-changes` ▶ `lines-changed` | 1.051 | 32.21 |
| `context-percent` ▶ `compact-countdown` (default) | 1.119 | 25.69 |
| `compact-countdown` ▶ `burn-rate` | 1.186 | 24.39 |
| `context-percent` ▶ `compact-countdown` (WARN) | 1.172 | **4.61** |
| `context-percent` ▶ `compact-countdown` (DANGER) | 1.298 | **6.54** |
| `today-spend` ▶ `vim NORMAL` | 1.415 | 9.14 |
| `git-branch` ▶ `git-changes` | 1.516 | 9.63 |

The genuinely close pairs are the two alert-state ones — exactly what the PR #39 code
review originally flagged. The broadening in the filed issue was an artifact of the metric.

## The threshold

Enumerating every adjacent background pair reachable in `DEFAULT_SETTINGS` — sweeping
context usage (25 values chosen to straddle every widget threshold including 62.5/75.1/83.5),
session cost, daily spend, and vim mode, then reading the pairs straight out of
`layoutPowerline` — yields **31 distinct pairs**. Sorted by ΔE2000, the low end is:

```
  0.00  #a67c00 | #a67c00     already thin under the exact-equality rule
  0.00  #c01c28 | #c01c28     already thin under the exact-equality rule
  4.61  #a67c00 | #b8860b     NEW -> thin
  6.54  #c01c28 | #a01822     NEW -> thin
  ---------------- threshold: ΔE 8 ----------------
  9.14  #26a269 | #2ec27e     stays wide
  9.63  #613583 | #7d4fa8     stays wide
 15.25  #a67c00 | #e5a50a     stays wide
 24.39  #1a5fb4 | #555555     stays wide
        ... 23 more, all above 24 ...
```

`MIN_SEPARATOR_DELTA = 8` changes exactly two boundaries, both alert-only. The default
healthy bar is untouched. The choice is not knife-edge: the nearest reachable values are
6.54 below and 9.14 above, so small errors in the constant change nothing.

A WCAG-style 3:1 floor was rejected: no boundary in the default layout reaches 1.94:1, so
every separator would become thin and the powerline arrow would disappear from the bar
entirely.

## Design

### 1. New module: `src/render/color-compare.ts`

`powerline.ts` currently carries `normalizeColor` and its hex regexes — chalk-mirroring
value parsing, not layout. Adding ~45 lines of CIEDE2000 beside it would deepen that
mismatch. Both concerns move to one module about comparing colors as values:

```ts
/** Resolve a color string to what chalk actually paints. Moved verbatim from powerline.ts. */
export function normalizeColor(color: string): string;

/** CIEDE2000 perceptual difference between two colors, after normalization. */
export function colorDistance(a: string, b: string): number;
```

The name keeps it clearly distinct from the existing `src/render/colors.ts`, which does
`colorize` and named-color resolution for the non-powerline path.

`colorDistance` normalizes both inputs before converting sRGB → linear → XYZ (D65) → Lab
and applying CIEDE2000. Normalizing first is what makes the PR #39 work carry over: `#fff`
and `#ffffff` reach ΔE 0 rather than being treated as different strings.

### 2. `powerline.ts`

Drops `sameColor`, `CHALK_HEX`, and `normalizeColor`; imports `colorDistance`. The
separator decision becomes:

```ts
/** Below this ΔE2000, two backgrounds are too close for the wide glyph to read. */
const MIN_SEPARATOR_DELTA = 8;
...
colorDistance(prev.bg, bg) < MIN_SEPARATOR_DELTA
  ? { text: thinSeparator, fg: prev.fg, bg }
  : { text: options.separator, fg: prev.bg, bg }
```

This strictly generalizes PR #39 rather than replacing it — identical colors give ΔE 0,
below any positive threshold, so the exact-collision case still takes the thin path. The
existing empty/whitespace `separatorThin` fallback is unchanged.

`normalizeColor` keeps its export, now from `color-compare.ts`;
`src/__tests__/defaults.test.ts` updates its import path.

### 3. Out of scope

- **No widget colors change.** Retiring `compact-countdown`'s `#b8860b`/`#a01822` so the
  alert states collide exactly was direction 3 on the issue and is not taken here.
- **The alert palette is not centralized.** Issue #36's third point stays open.
- **No configurable threshold.** A `powerline.minSeparatorDelta` setting was considered and
  rejected: it is a knob almost nobody can reason about, and the measured margin means a
  single constant serves every reachable state.
- **The non-powerline path is untouched**, as in PR #39.

## Testing

### CIEDE2000 correctness must not be self-verified

The formula has well-known implementation traps — the hue-average discontinuity across the
0°/360° boundary, and the `Rt` rotation term — and a subtly wrong implementation returns
plausible-looking numbers rather than obvious garbage. A test that pins whatever our own
code currently returns would lock in a bug.

**Expected values must come from the published CIEDE2000 test set (Sharma, Wu & Dalal,
*Color Research & Application* 30(1), 2005), or from an independent reference
implementation.** That data set exists precisely because implementations disagree; it
includes the pairs that expose the hue-wraparound and rotation-term errors. Deriving
expectations by running our own implementation is forbidden. If the implementer cannot
obtain independent values, they must say so in their report rather than invent them —
a fabricated expectation here is worse than no test.

Structural properties round it out: `colorDistance(x, x) === 0`, symmetry
(`d(a,b) === d(b,a)`), and that normalization feeds through (`d("#fff", "#ffffff") === 0`,
`d("red", "")` === 0 since chalk paints both black).

### `layoutPowerline` unit tests

In the existing `describe("layoutPowerline", ...)` block in `src/__tests__/renderer.test.ts`:

- `#a67c00` beside `#b8860b` (ΔE 4.61) → thin separator
- `#c01c28` beside `#a01822` (ΔE 6.54) → thin separator
- `#26a269` beside `#2ec27e` (ΔE 9.14) → wide separator
- `#613583` beside `#7d4fa8` (ΔE 9.63) → wide separator

The last two are the regression guard on the constant: they are what fails if someone
raises `MIN_SEPARATOR_DELTA` to 10. Reference the measured ΔE in a comment on each so the
next reader knows why those specific hexes were chosen.

All existing separator tests must keep passing unchanged — identical backgrounds, the
`#fff`/`#ffffff` case, the whitespace fallback, single-segment and empty input.

### The defaults sweep

`src/__tests__/defaults.test.ts` tightens its per-piece assertion from "fg differs from bg"
to `colorDistance(piece.fg, piece.bg) >= MIN_SEPARATOR_DELTA`, still skipping the closing
separator (no `bg`). This holds by construction — a wide separator is only emitted above
the threshold, and a thin one is a light foreground on a dark background — which is what
makes it a useful regression guard rather than a restatement.

`MIN_SEPARATOR_DELTA` is exported from `powerline.ts` so the test binds to the real
constant instead of duplicating the number.

### Verification

- `npm test` green, `npm run typecheck` clean
- `npm run build`, then confirm the two alert states render the thin glyph:
  - `used_percentage: 72` with `total_cost_usd: 2.10` → `│` between the context-percent bar
    (`#a67c00`) and the compact-countdown segment (`#b8860b`)
  - `used_percentage: 95` with `total_cost_usd: 2.10` → `│` between context-percent
    (`#c01c28`) and compact-countdown's "Compact imminent!" (`#a01822`)
- Confirm a healthy bar is byte-identical to PR #39's output (no boundary below ΔE 8 there)
- Clear `~/.cache/gccusage/statusline-cache.json` before eyeballing

## Follow-up

Issue #40's body must be corrected to replace the WCAG analysis with the ΔE2000 measurements
above, and to narrow the claim from "4 of 8 boundaries" to the two alert-state pairs.
Leaving the wrong analysis published would misdirect anyone who picks the issue up later.

## Commit requirements

`dist/index.js` is gitignored but force-tracked, and `gccusage setup` points
`statusLine.command` at it. Every commit touching `src/` must run `npm run build` and stage
the bundle with `git add -f dist/index.js`.

This branch stacks on `fix-36-powerline-thin-separator`. If PR #39 changes during review,
rebase before merging.
