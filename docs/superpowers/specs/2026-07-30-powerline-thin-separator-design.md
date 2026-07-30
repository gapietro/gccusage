# Powerline thin separator for same-background segments

**Issue:** [#36](https://github.com/gapietro/gccusage/issues/36) — Adjacent statusline segments merge when two alert-capable widgets hit the same threshold colour
**Date:** 2026-07-30

## Problem

`renderPowerlineSegments` (`src/render/powerline.ts`) draws every separator as the wide
glyph `▶` in the **previous** segment's runtime `bg`, painted over the **incoming**
segment's `bg`:

```ts
segments.push(chalk.hex(prevBg).bgHex(bg)(options.separator));
```

When `prevBg === bg` the glyph is the same colour as the surface behind it. The seam
disappears and the two segments read as one block.

Three widgets independently hard-code the same alert pair — amber `#a67c00`, red
`#c01c28`:

- `session-cost` (`sessionWarn` $5 / `sessionDanger` $15)
- `context-percent` (70% / 90%)
- `today-spend` (`dailyWarn` $10 / `dailyDanger` $25)

`session-cost` and `context-percent` are adjacent on line 1 of `DEFAULT_SETTINGS` and
have been since before the `compact-countdown` work (`git show aebb097:src/config/defaults.ts`),
so the merge is reachable in ordinary use: cost ≥ $5 with usage ≥ 70% renders two amber
segments with no visible boundary; cost ≥ $15 with usage ≥ 90% does the same in red.

Reproduce:

```bash
echo '{"session_id":"x","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":14.21},"context_window":{"used_percentage":70,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v | grep -o '48;2;[0-9;]*m [^ ]*'
```

## Framing: the palette is not the defect

The issue proposes giving each alert-capable widget its own amber/red pair. This design
rejects that reading.

Two adjacent widgets both showing amber is **semantically correct** — both are warning at
once, and that is exactly what the shared palette is meant to communicate. Forcing
`context-percent` onto a different amber than `session-cost` dilutes the signal to work
around a rendering limitation, and it is whack-a-mole: every new adjacency needs a new
shade, and user-authored `~/.config/gccusage/settings.json` colours stay unprotected no
matter how many shades ship.

The defect is that the renderer has no way to draw a boundary between same-background
segments. Powerline has a standard answer for this — the *thin* separator — and this
codebase already carries it as configuration:

- `DEFAULT_SETTINGS.powerline.separatorThin` is `│` (U+2502)
- `renderer.ts:58` plumbs it into `PowerlineOptions` with a `` fallback
- **nothing reads it.** It has been dead config since it was added.

Fixing the renderer resolves the whole class — the shipped defaults, every future layout
change, and arbitrary user colour configs — in one place.

## Design

### 1. Split styling from painting

`renderPowerlineSegments` currently tangles two concerns: deciding what colour each piece
gets, and painting it with chalk. Separate them:

```ts
export interface PowerlinePiece {
  text: string;
  fg: string;
  /** Absent only for the closing separator, which paints on the terminal's own background. */
  bg?: string;
}

/** Alternating segment/separator pieces, fully resolved against the theme. */
export function layoutPowerline(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): PowerlinePiece[];

export function renderPowerlineSegments(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): string;
// = layoutPowerline(...)
//     .map(p => (p.bg ? chalk.hex(p.fg).bgHex(p.bg) : chalk.hex(p.fg))(p.text))
//     .join("")
```

`layoutPowerline` owns theme-index resolution (`theme.segments[i % length]`) and the
`output.fg ?? style.fg` / `output.bg ?? style.bg` fallbacks, so every piece it returns has
`fg` and `bg` fully resolved to concrete hex strings. `renderPowerlineSegments` keeps its
exact current signature and return value; `renderer.ts` needs no change.

### 2. Separator selection

Inside `layoutPowerline`, the separator between segment `i-1` and segment `i`:

| Case | glyph | fg | bg |
|---|---|---|---|
| `prevBg !== bg` (today's behaviour) | `options.separator` (`▶`) | `prevBg` | `bg` |
| `prevBg === bg` (new) | `options.separatorThin` (`│`) | `prevFg` | `bg` |

The closing separator is unchanged: `options.separator` in `prevBg`, no background.

Three details:

- **Comparison is lowercase-normalized.** `#A67C00` written by hand in a user's
  `settings.json` and `#a67c00` hard-coded in a widget are the same colour and must take
  the thin path. Compare `prevBg.toLowerCase() === bg.toLowerCase()`.
- **Width is unchanged.** One glyph either way, so `renderCompact`'s `sepWidth = 3`
  (`src/render/renderer.ts:86`) and `truncateAnsi` need no adjustment.
- **`prevFg` must be tracked** alongside `prevBg` through the loop.

Rendered result at $14 session cost / 70% context:

```
 Opus 4.6 ▶ $14.21 │ [=======---] 70% (200k) ▶ ~28k left
                   ^
                   thin divider marks the seam inside one amber block
```

### 3. Out of scope

- **Widget colours do not change.** `compact-countdown` keeps `#b8860b`/`#a01822` and
  `vim-mode` INSERT keeps `#e5a50a`. Those shades were added as collision workarounds and
  become redundant once the renderer is fixed, but retiring them is visual churn for
  existing users and unrelated to making the seam visible.
- **No shared alert-palette module.** The issue's point 3 — whether "alert" should be a
  centrally allocated concern rather than three widgets independently reaching for the
  same two hexes — stays open. It is a real question, but with the renderer fixed it is a
  code-organization preference rather than a defect, and a speculative module is not
  earned here.
- **The non-powerline path is untouched.** `renderLine`'s `else` branch joins
  `colorize(o.text, o.fg, o.bg)` outputs with `""` and no padding, so neighbouring
  segments run together (`Today: $3.00[=======---] 70%`) regardless of colour. That is a
  real defect, but a different one; #36 is scoped to `renderPowerlineSegments`.

## Testing

### The existing assertion becomes wrong

`src/__tests__/defaults.test.ts` sweeps `DEFAULT_SETTINGS` and asserts:

> no two adjacent rendered segments share a `bg`

After this fix, sharing a `bg` is **legal** — it is precisely what happens when two
widgets warn simultaneously, and the thin separator handles it. The invariant that test
was reaching for lives one level down:

> **every piece the renderer emits is visible against its own background** — i.e. it
> either has no background at all (the closing separator) or has `fg !== bg`

That single predicate covers separators (a seam you can actually see) *and* segment text
(readable content), uniformly. It also catches a case the old assertion could not: a
future widget whose `fg` matches its own `bg` renders invisible text and would have passed.

`layoutPowerline` exists so this test can assert against the renderer's real styling model
instead of re-deriving theme indexing in test code — a copy that could drift out of sync
with the renderer and quietly stop testing it.

### Changes

**1. New unit tests on `layoutPowerline`** (`src/__tests__/renderer.test.ts`):

- differing bgs → wide glyph, `fg === prevBg`, `bg === currBg`
- equal bgs → thin glyph, `fg === prevFg`, `bg === currBg`
- `#A67C00` vs `#a67c00` → thin glyph (case-insensitive match)
- single segment → no separator piece, closing separator present
- empty outputs → empty result
- theme fallback: outputs with no `fg`/`bg` resolve from `theme.segments[i % length]`

**2. Widen the sweep** (`src/__tests__/defaults.test.ts`):

Add the dimension the issue calls out as deliberately pinned:

```ts
const SESSION_SWEEP = [2.5, 8, 20]; // below sessionWarn / ≥ warn / ≥ danger
```

Cross product becomes 9 usage × 3 today × 2 vim × 3 session = 162 points. `SweepPoint`
gains a `session` field; `makeSweepContext` sets `sessionCostUsd: point.session` in place
of the hard-coded `2.5`, and the comment block explaining why it is pinned to #36 goes
away — that pin is the specific thing this issue complains about, a suite that reads as
covered while a known defect ships.

Replace `assertNoAdjacentCollision` with an assertion that runs each sweep point's real
widget outputs through `layoutPowerline(outputs, DEFAULT_SETTINGS.powerline)` and checks
every returned piece has `bg === undefined || fg !== bg`, with a failure message naming
all four sweep coordinates. Keep both existing cases — per-line, and the compact-mode
flattening that sorts by priority across line boundaries.

### Verification

- `npm test` green, including the 162-point sweep
- `npm run build`, then the reproduce command above shows a `│` between the two amber
  segments instead of an invisible boundary
- Clear `~/.cache/gccusage/statusline-cache.json` before eyeballing the live bar (5s TTL)

## Commit requirements

`dist/index.js` is gitignored but force-tracked, and `gccusage setup` points
`statusLine.command` at it. Every commit touching `src/` must run `npm run build` and
stage the bundle with `git add -f dist/index.js`, or `git pull` upgraders keep running the
old code.
