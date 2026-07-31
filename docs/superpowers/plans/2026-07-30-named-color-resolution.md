# Named Color Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make named colors (`"red"`, `"blue"`, …) render as their mapped hex in the powerline path — the default rendering mode — instead of silently painting black.

**Architecture:** `src/render/colors.ts` already has `NAMED_COLORS` and a `resolveColor` that substitutes a known name and passes everything else through untouched. It is simply never called on the powerline path. Export both, and apply `resolveColor` at exactly two sites: where `layoutPowerline` resolves each segment's colors before chalk paints them, and at the top of `normalizeColor` before chalk's hex mirror. Both together, so painting and comparison stay in agreement.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, chalk v5, tsdown bundler.

**Spec:** `docs/superpowers/specs/2026-07-30-named-color-resolution-design.md`
**Branch:** `fix-named-colors-powerline` (off `main` at `aa4b854`)

## Global Constraints

- **`dist/index.js` is gitignored but force-tracked.** `gccusage setup` points `statusLine.command` at it, so any commit touching `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`. A src-only commit leaves `git pull` upgraders on the old code.
- **Imports use `.js` specifiers** even for TypeScript sources (`from "./colors.js"`). The project is `"type": "module"`.
- **No file under `src/widgets/` may change.**
- **`NAMED_COLORS` values are not to be changed.** Pure `#ff0000`-style primaries are harsh for a statusline, but re-picking them is a separate subjective call and would alter the non-powerline path that works today.
- **`colorize` and the non-powerline path are not to be changed.** `colorize` already calls `resolveColor`; its `startsWith("#")` fallbacks (`#808080` for fg, `#000000` for bg) stay exactly as they are.
- **ansi256 is NOT implemented here.** The schema comment drops the claim; the feature gets its own issue.
- **`layoutPowerline` and `renderPowerlineSegments` keep their exact signatures**, so `src/render/renderer.ts` needs no edit.
- **No new dependency.**
- **Test commands:** `npm test`, `npx vitest run src/__tests__/<file>`, `npm run typecheck`. The suite is currently 152/152 green.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/render/colors.ts` | Modify | Export `NAMED_COLORS` and `resolveColor` (both currently module-private) |
| `src/render/powerline.ts` | Modify | Resolve names before chalk paints |
| `src/render/color-compare.ts` | Modify | Resolve names before chalk's hex mirror |
| `src/config/schema.ts` | Modify | Drop the unimplemented ansi256 claim from the comment |
| `src/__tests__/renderer.test.ts` | Modify | Invert the `red`/`blue` separator expectation |
| `src/__tests__/color-compare.test.ts` | Modify | Invert two named-colors-are-black assertions; add per-name coverage |

---

## Task 1: Resolve named colors on the powerline path

**Files:**
- Modify: `src/render/colors.ts:3` (export `NAMED_COLORS`), `:18` (export `resolveColor`)
- Modify: `src/render/color-compare.ts` (import `resolveColor`; apply it at the top of `normalizeColor`)
- Modify: `src/render/powerline.ts:49-50` (apply `resolveColor` to `fg` and `bg`)
- Modify: `src/__tests__/color-compare.test.ts:14-18` and `:99`
- Modify: `src/__tests__/renderer.test.ts:241-252`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const NAMED_COLORS: Record<string, string>` from `src/render/colors.ts`
  - `export function resolveColor(color: string): string` from `src/render/colors.ts` — returns `NAMED_COLORS[color.toLowerCase()] ?? color`, i.e. substitutes a known name and passes everything else through unchanged.

---

- [ ] **Step 1: Invert the three tests that encode the current defect**

These assert the buggy behavior today. Correcting them *is* the failing test for this change.

In `src/__tests__/color-compare.test.ts`, replace the test at lines 14-18:

```ts
  it("collapses non-hex values to the black chalk paints them as", () => {
    expect(normalizeColor("red")).toBe("#000000");
    expect(normalizeColor("blue")).toBe("#000000");
    expect(normalizeColor("")).toBe("#000000");
  });
```

with:

```ts
  it("resolves named colors before falling back to chalk's hex parse", () => {
    expect(normalizeColor("red")).toBe("#ff0000");
    expect(normalizeColor("blue")).toBe("#0000ff");
  });

  it("is case-insensitive for named colors", () => {
    expect(normalizeColor("RED")).toBe("#ff0000");
    expect(normalizeColor("Red")).toBe("#ff0000");
  });

  it("collapses values that are neither a known name nor hex", () => {
    expect(normalizeColor("")).toBe("#000000");
    expect(normalizeColor("#")).toBe("#000000");
    expect(normalizeColor("banana")).toBe("#000000");
  });

  // Guards the property the separator logic rests on: every name in the map
  // must resolve, so adding an entry without wiring it up fails here.
  it("resolves every entry in NAMED_COLORS", () => {
    for (const [name, hex] of Object.entries(NAMED_COLORS)) {
      expect(normalizeColor(name), name).toBe(hex);
    }
  });
```

Add `NAMED_COLORS` to that file's imports:

```ts
import { NAMED_COLORS } from "../render/colors.js";
```

Then replace line 99 and its comment:

```ts
    // chalk paints both of these black.
    expect(colorDistance("red", "")).toBe(0);
```

with:

```ts
    // "red" now resolves to #ff0000 while "" is still the black chalk paints
    // it as, so these are far apart rather than both black. Measured ΔE is
    // 50.41; the assertion is loose because the exact figure is not the point
    // — that it clears MIN_SEPARATOR_DELTA by a wide margin is.
    expect(colorDistance("red", "")).toBeGreaterThan(40);
```

In `src/__tests__/renderer.test.ts`, replace the test at lines 241-252:

```ts
  it("draws the thin separator for two different named colors (both paint black)", () => {
    // chalk.bgHex("red") and chalk.bgHex("blue") both fail hex parsing and
    // paint 48;2;0;0;0 — identical backgrounds despite distinct config values.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "red" },
        { text: "b", fg: "#ffffff", bg: "blue" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });
```

with:

```ts
  it("draws the wide separator for two named colors that resolve apart", () => {
    // "red" and "blue" resolve to #ff0000 and #0000ff — ΔE 52.88, far above
    // MIN_SEPARATOR_DELTA — so the separator decision follows the colors
    // actually painted. This test previously asserted the thin glyph, because
    // both names failed chalk's hex parse and painted black. That was the
    // defect this change fixes.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "red" },
        { text: "b", fg: "#ffffff", bg: "blue" },
      ],
      OPTIONS,
    );
    expect(pieces[1]).toEqual({ text: "▶", fg: "#ff0000", bg: "#0000ff" });
  });

  it("resolves named colors to the same pieces as their mapped hex", () => {
    // The property the separator logic rests on: comparison and painting must
    // agree about what a config value means.
    const named = layoutPowerline([{ text: "a", fg: "white", bg: "red" }], OPTIONS);
    const hex = layoutPowerline([{ text: "a", fg: "#ffffff", bg: "#ff0000" }], OPTIONS);
    expect(named).toEqual(hex);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/color-compare.test.ts src/__tests__/renderer.test.ts`

Expected: FAIL.
- `color-compare.test.ts` — the import of `NAMED_COLORS` fails to resolve (it is not exported yet), so the whole file errors.
- Once that is past, `normalizeColor("red")` returns `"#000000"` rather than `"#ff0000"`.
- `renderer.test.ts` — the `red`/`blue` case gets `{ text: "│", fg: "#ffffff", bg: "red" }`, because both names collapse to black and the thin branch fires.

- [ ] **Step 3: Export the two symbols from `colors.ts`**

In `src/render/colors.ts`, change line 3 from:

```ts
const NAMED_COLORS: Record<string, string> = {
```

to:

```ts
export const NAMED_COLORS: Record<string, string> = {
```

and line 18 from:

```ts
function resolveColor(color: string): string {
```

to:

```ts
/**
 * Substitute a known color name with its hex value; pass anything else through
 * untouched so the caller's own parsing (chalk's, or `colorize`'s
 * `startsWith("#")` guard) still applies.
 */
export function resolveColor(color: string): string {
```

Nothing else in the file changes — `colorize` keeps calling `resolveColor` exactly as before.

- [ ] **Step 4: Resolve names inside `normalizeColor`**

In `src/render/color-compare.ts`, add the import below the existing header comment:

```ts
import { resolveColor } from "./colors.js";
```

Then change the body of `normalizeColor` from:

```ts
export function normalizeColor(color: string): string {
  const match = CHALK_HEX.exec(color);
```

to:

```ts
export function normalizeColor(color: string): string {
  // Named colors first: the renderer substitutes them before chalk sees them,
  // so the comparison must do the same or it would judge "red" to be the black
  // chalk paints for an unparseable string. Anything else falls through to
  // chalk's own hex parse below, unchanged.
  const match = CHALK_HEX.exec(resolveColor(color));
```

Also update the function's doc comment: the existing text says non-hex input including "named colors" collapses to black. Change that clause to say named colors resolve via `resolveColor` first, and only values that are neither a known name nor hex-parseable collapse to black.

- [ ] **Step 5: Resolve names where powerline paints**

In `src/render/powerline.ts`, add `resolveColor` to the imports:

```ts
import { resolveColor } from "./colors.js";
```

Then change lines 49-50 from:

```ts
    const fg = output.fg ?? style.fg;
    const bg = output.bg ?? style.bg;
```

to:

```ts
    // Resolve here rather than at paint time so the pieces this function
    // returns carry the colors that will actually be painted — the separator
    // decision below and every test depend on that.
    const fg = resolveColor(output.fg ?? style.fg);
    const bg = resolveColor(output.bg ?? style.bg);
```

Note: `colorDistance` is called a few lines below on these already-resolved values, so `normalizeColor` will resolve a second time. That is harmless — `resolveColor` on a hex string is a passthrough, so it is idempotent — and the call inside `normalizeColor` is still needed for its other callers, which pass raw config values.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/color-compare.test.ts src/__tests__/renderer.test.ts`
Expected: PASS, including every pre-existing case in both files. In particular the `#fff`/`#ffffff`, `#abcd`, `#12345`, `#gggggg` and whitespace-separator cases must be unaffected — `resolveColor` passes all of those through untouched.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both PASS. The `defaults.test.ts` sweep and `themes.test.ts` must be unaffected, since `DEFAULT_SETTINGS` and every theme use hex only.

- [ ] **Step 8: Verify against the real binary**

```bash
npm run build
rm -f ~/.cache/gccusage/statusline-cache.json
mkdir -p /tmp/gcc-named/.config/gccusage
cat > /tmp/gcc-named/.config/gccusage/settings.json <<'JSON'
{
  "lines": [{ "widgets": [
    { "type": "model", "fg": "white", "bg": "red" },
    { "type": "session-cost", "fg": "white", "bg": "blue" }
  ] }],
  "powerline": { "enabled": true, "theme": "default", "separator": "▶", "separatorThin": "│" }
}
JSON
echo '{"session_id":"n","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":2.10},"context_window":{"used_percentage":30,"context_window_size":200000}}' \
  | XDG_CONFIG_HOME=/tmp/gcc-named/.config HOME=/tmp/gcc-named node dist/index.js | head -1 | cat -v
```

Expected: the two segments render `48;2;255;0;0` (red) and `48;2;0;0;255` (blue), with a `▶` between them. Before this change both were `48;2;0;0;0` with an invisible seam. Paste the output into your report.

If the config is not picked up (the segments render in default colors rather than red/blue), check how `src/config/loader.ts` locates `settings.json` and adjust the env vars — report what you found rather than skipping the check.

- [ ] **Step 9: Confirm the shipped defaults did not move**

```bash
rm -f ~/.cache/gccusage/statusline-cache.json
echo '{"session_id":"d","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":2.10},"context_window":{"used_percentage":30,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v
```

Expected: identical to `main`'s output for the same input — the defaults use only hex, so `resolveColor` passes every value through. Four `▶`, no `│`. Confirm in your report.

- [ ] **Step 10: Correct the schema comment**

In `src/config/schema.ts`, change lines 3-5 from:

```ts
const ColorSchema = v.union([
  v.string(), // named color, hex, or ansi256
]);
```

to:

```ts
const ColorSchema = v.union([
  // Named colors (see NAMED_COLORS in src/render/colors.ts) and hex, in either
  // 3- or 6-digit form. ansi256 codes are NOT supported — see the linked issue.
  v.string(),
]);
```

- [ ] **Step 11: Commit**

```bash
npm run build
git add src/render/colors.ts src/render/color-compare.ts src/render/powerline.ts \
        src/config/schema.ts src/__tests__/color-compare.test.ts src/__tests__/renderer.test.ts
git add -f dist/index.js
git commit -m "Resolve named colors in the powerline path

The settings schema documents named colors as valid and colors.ts backs that
with a NAMED_COLORS map, but resolveColor was never called on the powerline
path — the default rendering mode. chalk.bgHex(\"red\") fails hex parsing and
emits 48;2;0;0;0, so a user following the documented schema got a black
segment, silently. The same config worked with powerline disabled, because
that path does resolve.

Applies the existing resolver at two sites, in one change: where
layoutPowerline resolves each segment's colors, and at the top of
normalizeColor. Both together — colorDistance exists to predict what chalk
paints, so resolving on only one side would leave the comparison judging
\"red\" to be black and putting a thin separator between two clearly
different colors.

Nothing else moves: hex and unparseable input keep chalk's existing
behavior, and colorize and the non-powerline path are untouched.

The schema comment also drops its ansi256 claim, which is unimplemented in
both paths.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Ship it

**Files:** none modified — branch, PR, and issue mechanics.

**Interfaces:**
- Consumes: the commit from Task 1, plus the spec commit `8c7dc60` already on the branch.
- Produces: a pull request, and a new issue for ansi256.

---

- [ ] **Step 1: Confirm the tree is clean and the build is current**

```bash
npm test && npm run typecheck && npm run build && git status --short
```

Expected: tests and typecheck PASS, and `git status --short` prints nothing. If `dist/index.js` shows as modified, Task 1's commit staged a stale bundle — amend it.

- [ ] **Step 2: Push the branch**

```bash
git rev-parse --abbrev-ref HEAD   # expect: fix-named-colors-powerline
git push -u origin fix-named-colors-powerline
```

- [ ] **Step 3: File the ansi256 issue**

```bash
gh issue create --title "ansi256 color codes are advertised but unimplemented, and silently paint a wrong color" --body "$(cat <<'EOF'
`ColorSchema` in `src/config/schema.ts` advertised `named color, hex, or ansi256`. Named colors now work in both render paths. **ansi256 works in neither**, and in the powerline path it does not fail loudly — it paints an arbitrary unrelated color.

chalk's `hexToRgb` uses an unanchored `/[a-f\d]{6}|[a-f\d]{3}/i`, so a 3-digit ansi256 code is read as 3-digit hex:

| config value | painted | correct ansi256 |
|---|---|---|
| `"196"` | `48;2;17;153;102` (`#119966`, green-teal) | `48;5;196` |
| `"21"` | `48;2;0;0;0` (black — too short to match) | `48;5;21` |

In the non-powerline path, `colorize`'s `startsWith("#")` guard catches it and falls back to `#808080`/`#000000` — wrong, but at least uniform.

The schema comment has been corrected to claim only what is supported. This issue tracks whether to implement the feature.

## Why it is not a one-liner

- **`colorDistance` would need an ansi256 → RGB conversion.** The separator rule (`colorDistance(prevBg, bg) < MIN_SEPARATOR_DELTA`) is meaningful only if the comparison predicts what is painted. An unconverted ansi256 value would land on the wrong side of the ΔE floor.
- **3-digit codes are ambiguous with 3-digit hex.** `"196"` is a valid ansi256 code *and* a valid 3-digit hex color under chalk's parsing. Supporting both needs an explicit disambiguation rule — e.g. requiring a prefix like `ansi256:196`, which is a config-format change.
- **Themes and defaults are truecolor.** `chalk.level = 3` is forced in `powerline.ts`; mixing `48;5;N` and `48;2;R;G;B` in one bar is fine for terminals but means two color spaces to reason about.

The cheapest honest alternative is to reject non-hex, non-named values at config-load time with a clear error, rather than letting them through to be misparsed.
EOF
)"
```

- [ ] **Step 4: Open the pull request**

```bash
gh pr create --title "Resolve named colors in the powerline path" --body "$(cat <<'EOF'
## Problem

`ColorSchema` documents `fg`/`bg` as accepting a named color, and `src/render/colors.ts` backs that with a `NAMED_COLORS` map (`red` → `#ff0000`, 12 entries) plus a `resolveColor` that substitutes them.

**`resolveColor` was never called on the powerline path** — the mode that ships by default. `renderPowerlineSegments` handed the raw string to chalk, which parsed it as hex, failed, and emitted black:

```
chalk.bgHex("red")  -> 48;2;0;0;0
chalk.bgHex("blue") -> 48;2;0;0;0
```

So a user who followed the documented schema and wrote `{ "bg": "red" }` got a black segment, silently. The same config worked with `powerline.enabled: false`, because that path does resolve. No entry in `NAMED_COLORS` contains three consecutive hex characters, so every named color failed the same way — the breakage was uniform, not partial.

## Fix

Apply the existing resolver at two sites, in one change:

- `layoutPowerline`, where each segment's colors are resolved, so the returned pieces carry what will actually be painted
- the top of `normalizeColor`, before chalk's hex mirror

**Both together, deliberately.** `colorDistance` exists to predict what chalk paints, so that `colorDistance(prevBg, bg) < MIN_SEPARATOR_DELTA` picks the right separator. Resolving on only one side would leave the comparison judging `"red"` to be black — putting a thin separator between two clearly different colors, or the reverse.

Nothing else moves. `#abcd` still resolves through chalk's unanchored regex to `#aabbcc`; `banana` still paints black. `colorize` and the non-powerline path are untouched — named colors already worked there.

## Tests

Three existing tests asserted the defect, and inverting them is the proof:

| test | asserted | now |
|---|---|---|
| `renderer.test.ts` `red`/`blue` separator | **thin** ("both paint black") | **wide**, `fg #ff0000` / `bg #0000ff` |
| `normalizeColor("red")` | `#000000` | `#ff0000` |
| `colorDistance("red", "")` | `0` | > 50 |

The `renderer.test.ts` one is a good test that documents "the separator follows what is painted" — only the painted value changed.

Added: every `NAMED_COLORS` entry resolves (table-driven over the map, so adding a name without wiring it up fails), case-insensitivity, and a check that a named config produces byte-identical pieces to its mapped hex — the property the separator logic rests on.

Verified the shipped defaults are unchanged: they use only hex, so `resolveColor` passes every value through.

## Not in scope

- **ansi256** — advertised but unimplemented in both paths, and in powerline mode a 3-digit code silently paints an arbitrary color (`196` → `#119966`) rather than failing. The schema comment now claims only what is supported; filed separately, since implementing it needs an ansi256 → RGB conversion for `colorDistance` and a disambiguation rule against 3-digit hex.
- **The `NAMED_COLORS` values.** Pure `#ff0000`-style primaries are harsh for a statusline, but re-picking them is a subjective call that would also change the working non-powerline path.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Verify the PR contents**

Run: `gh pr view --json files -q '.files[].path'`

Expected: `dist/index.js`, `src/config/schema.ts`, `src/render/color-compare.ts`, `src/render/colors.ts`, `src/render/powerline.ts`, `src/__tests__/color-compare.test.ts`, `src/__tests__/renderer.test.ts`, plus the two docs under `docs/superpowers/`. **No file under `src/widgets/`.** If `dist/index.js` is missing, the bundle was not staged.

---

## Verification Checklist

- [ ] `npm test` passes; `npm run typecheck` clean
- [ ] `normalizeColor` resolves every entry in `NAMED_COLORS`, case-insensitively
- [ ] A named config and its mapped-hex equivalent produce identical `layoutPowerline` output
- [ ] `#abcd`, `#12345`, `#gggggg`, `""` and whitespace-separator cases all still behave as before
- [ ] A settings file with `bg: "red"` renders `48;2;255;0;0` against the built binary
- [ ] The shipped defaults render byte-identically to `main`
- [ ] `dist/index.js` staged in the commit that touches `src/`
- [ ] No widget file in the diff
- [ ] ansi256 issue filed
