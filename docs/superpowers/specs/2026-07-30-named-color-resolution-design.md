# Named color resolution in the powerline path

**Date:** 2026-07-30
**Follows:** PR #39 (issue #36), PR #41 (issue #40) — both merged

## Problem

`ColorSchema` (`src/config/schema.ts:3-5`) documents what a user may write for `fg`/`bg`:

```ts
const ColorSchema = v.union([
  v.string(), // named color, hex, or ansi256
]);
```

`src/render/colors.ts` backs the first claim with a `NAMED_COLORS` map (`red` → `#ff0000`,
`blue` → `#0000ff`, 12 entries) and a `resolveColor` that substitutes them.

**`resolveColor` is never called on the powerline path** — the default rendering mode.
`renderPowerlineSegments` hands the raw string to `chalk.hex()`/`chalk.bgHex()`, which parse
it as hex, fail, and emit black:

```
chalk.bgHex("red")  -> 48;2;0;0;0
chalk.bgHex("blue") -> 48;2;0;0;0
```

So a user who follows the documented schema and writes `{ "bg": "red" }` gets a black segment,
silently, in the mode that ships by default. The same config works correctly with
`powerline.enabled: false`, because that path does call `resolveColor`.

No entry in `NAMED_COLORS` contains three consecutive hex characters, so every named color
fails chalk's parse the same way. The failure is uniform, not partial.

### The ansi256 claim is worse

`ansi256` works in neither path, and in powerline mode it does not fail loudly — it paints an
arbitrary unrelated color. chalk's `hexToRgb` uses an unanchored `/[a-f\d]{6}|[a-f\d]{3}/i`, so
a 3-digit ansi256 code is read as 3-digit hex:

```
chalk.bgHex("196") -> 48;2;17;153;102   i.e. #119966, a green-teal
chalk.bgHex("21")  -> 48;2;0;0;0        (too short to match; black)
```

Correct ansi256 output would be `48;5;196`, via `chalk.bgAnsi256(196)`.

## Design

### 1. Apply the existing resolver at two call sites

`resolveColor` already has exactly the right shape — substitute a known name, pass everything
else through untouched:

```ts
function resolveColor(color: string): string {
  return NAMED_COLORS[color.toLowerCase()] ?? color;
}
```

Both it and `NAMED_COLORS` are currently module-private in `src/render/colors.ts`. Both need
exporting — `resolveColor` for the two call sites below, and `NAMED_COLORS` so the tests can be
table-driven over the map itself rather than restating its entries.

Applied in two places:

**`src/render/powerline.ts`** — in `layoutPowerline`, when resolving each segment's colors,
before any value reaches chalk:

```ts
const fg = resolveColor(output.fg ?? style.fg);
const bg = resolveColor(output.bg ?? style.bg);
```

Resolving here rather than in `renderPowerlineSegments` means the resolved values are what
`layoutPowerline` returns, so the separator decision and the tests both see painted colors.

**`src/render/color-compare.ts`** — at the top of `normalizeColor`, before chalk's mirror:

```ts
export function normalizeColor(color: string): string {
  const resolved = resolveColor(color);
  const match = CHALK_HEX.exec(resolved);
  ...
}
```

### 2. Why both, together

`colorDistance` exists to predict what chalk will paint, so that
`colorDistance(prevBg, bg) < MIN_SEPARATOR_DELTA` picks the right separator. Changing one side
alone breaks that:

- resolve only when painting → comparison still thinks `red` is black, so `red` beside `blue`
  is judged identical and gets a thin separator between two clearly different colors
- resolve only when comparing → the reverse

Applying the same substitution on both sides, then deferring to the same chalk parse for
everything else, keeps them in agreement by construction.

Note that `layoutPowerline` calls `colorDistance` on values it has *already* resolved, so
`normalizeColor` resolves a second time. That is harmless — `resolveColor` on a hex string is a
passthrough, so it is idempotent — and keeping the call in `normalizeColor` matters for the
other callers, which pass raw config values.

### 3. What does not change

- **Hex and junk input.** `#abcd` still resolves through chalk's unanchored regex to `#aabbcc`;
  `banana` still paints black. Only named colors move.
- **`colorize` and the non-powerline path.** It already calls `resolveColor`; named colors work
  there today and behave identically after this change. Its `startsWith("#")` fallbacks
  (`#808080` for fg, `#000000` for bg) are untouched.
- **The `NAMED_COLORS` values.** Pure `#ff0000`-style primaries are harsh for a statusline, but
  re-picking them is a subjective call that would also alter the working non-powerline path.
  Out of scope.
- **Precedence.** Name substitution runs *before* the hex parse, matching `colorize`. No current
  `NAMED_COLORS` key is hex-parseable, so this is not observable today, but the ordering is the
  correct one if a future name ever collides.

### 4. Schema comment

`// named color, hex, or ansi256` becomes `// named color or hex` — what the code supports after
this change. ansi256 gets its own issue rather than a silent doc that promises it.

## Testing

### Three existing tests inverting is the proof

They currently encode the defect, and correcting them is how the fix demonstrates itself:

| location | asserts today | after |
|---|---|---|
| `src/__tests__/renderer.test.ts:241` | `red` beside `blue` → **thin** separator, "both paint black" | → **wide** separator |
| `src/__tests__/color-compare.test.ts:15-16` | `normalizeColor("red")` → `#000000` | → `#ff0000` |
| `src/__tests__/color-compare.test.ts:99` | `colorDistance("red", "")` → 0 | → large, non-zero |

The `renderer.test.ts` case is a good test, not a bad one: it documents that the separator
decision follows what is actually painted. Only the painted value changes. Rewrite its comment
to say the two named colors now resolve to distinct hexes, and keep it asserting the renderer
follows them.

### New coverage

- **Every `NAMED_COLORS` key resolves**, through `normalizeColor`, to its mapped hex —
  table-driven over the map itself, so adding a name without wiring it up fails.
- **Both paths agree**: for each named color, the ANSI emitted by `renderPowerlineSegments`
  matches the ANSI for its mapped hex. This is the property the separator logic rests on, and
  the one that was broken.
- **Case-insensitivity**: `"RED"` and `"Red"` resolve like `"red"`.
- **End-to-end regression**: a widget configured `bg: "red"` renders `48;2;255;0;0`, not
  `48;2;0;0;0`.

### Verification

- `npm test` green, `npm run typecheck` clean
- `npm run build`, then confirm a settings file with a named `bg` renders that color
- Confirm the shipped defaults are byte-identical — they use only hex, so nothing should move

## Follow-up

File an issue for ansi256: it is advertised, unimplemented in both paths, and in powerline mode
3-digit codes silently paint an arbitrary color (`196` → `#119966`) instead of failing. Note
that implementing it would require `colorDistance` to convert ansi256 → RGB to keep the ΔE rule
meaningful, and that 3-digit codes are ambiguous with 3-digit hex — so it is a real design
question, not a one-liner.

## Commit requirements

`dist/index.js` is gitignored but force-tracked, and `gccusage setup` points
`statusLine.command` at it. Every commit touching `src/` must run `npm run build` and stage the
bundle with `git add -f dist/index.js`.
