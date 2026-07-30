# Perceptual Separator Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the powerline renderer's thin-separator rule from exact background equality to perceptual closeness, so a separator between two nearly-identical backgrounds stays visible.

**Architecture:** A new `src/render/color-compare.ts` owns comparing colors as values — it takes `normalizeColor` (moved out of `powerline.ts`) and adds `colorDistance`, a CIEDE2000 perceptual difference computed over normalized inputs. `powerline.ts` swaps its exact-equality check for `colorDistance(prevBg, bg) < MIN_SEPARATOR_DELTA` (8), which strictly generalizes the existing behavior since identical colors give ΔE 0.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, chalk v5, tsdown bundler.

**Spec:** `docs/superpowers/specs/2026-07-30-perceptual-separator-threshold-design.md`
**Issue:** [#40](https://github.com/gapietro/gccusage/issues/40)
**Branch:** `fix-40-perceptual-separator-threshold`, stacked on `fix-36-powerline-thin-separator` (PR #39, unmerged)

## Global Constraints

- **`dist/index.js` is gitignored but force-tracked.** `gccusage setup` points `statusLine.command` at it, so any commit touching `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`. A src-only commit ships stale code to `git pull` upgraders.
- **Imports use `.js` specifiers** even for TypeScript sources (`from "./color-compare.js"`). The project is `"type": "module"`.
- **No file under `src/widgets/` may change.** Retiring `compact-countdown`'s bespoke `#b8860b`/`#a01822` shades was direction 3 on the issue and is not taken here.
- **No new runtime dependency.** CIEDE2000 is implemented in-repo. Any package used to *verify* it must be a throwaway (`npx` / temp install), never added to `package.json`.
- **No configurable threshold.** `MIN_SEPARATOR_DELTA` is a module constant, not a setting.
- **The non-powerline render path is not touched.**
- **`renderPowerlineSegments` and `layoutPowerline` keep their exact signatures**, so `src/render/renderer.ts` needs no edit.
- **Expected ΔE values in tests must never be derived from our own implementation.** See Task 1 — this is the single most important rule in this plan.
- **Test commands:** `npm test`, `npx vitest run src/__tests__/<file>`, `npm run typecheck`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/render/color-compare.ts` | **Create** | Compare colors as values: normalize to what chalk paints, measure perceptual distance |
| `src/render/powerline.ts` | Modify | Layout only — drops `normalizeColor`, `CHALK_HEX`, `sameColor`; gains `MIN_SEPARATOR_DELTA` |
| `src/__tests__/color-compare.test.ts` | **Create** | CIEDE2000 correctness against independent values + structural properties |
| `src/__tests__/renderer.test.ts` | Modify | Separator decision at the new threshold, both sides of it |
| `src/__tests__/defaults.test.ts` | Modify | Sweep assertion tightens to a distance floor; import path updates |
| `README.md` | Modify | Separators section: "same or near-identical" |

---

## Task 1: `color-compare.ts` with independently-verified CIEDE2000

**Files:**
- Create: `src/render/color-compare.ts`
- Create: `src/__tests__/color-compare.test.ts`
- Modify: `src/render/powerline.ts` (remove `CHALK_HEX` at :28, `normalizeColor` at :30-50, and their comment block at :22-27; import `normalizeColor` from the new module)
- Modify: `src/__tests__/renderer.test.ts` (move the `describe("normalizeColor", ...)` block at lines 327-357 out to the new test file; drop `normalizeColor` from the import at line 3)
- Modify: `src/__tests__/defaults.test.ts:4` (re-point its `normalizeColor` import at the new module)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function normalizeColor(color: string): string` — moved verbatim from `powerline.ts`, behavior unchanged.
  - `export function colorDistance(a: string, b: string): number` — CIEDE2000 ΔE between two color strings, each passed through `normalizeColor` first. Returns 0 for identical inputs. Task 2 depends on this exact name and signature.

---

- [ ] **Step 1: Create the module**

Create `src/render/color-compare.ts`:

```ts
// Comparing colors as values: what chalk actually paints for a given string,
// and how far apart two painted colors look. Kept out of powerline.ts so that
// file stays about layout.

// Mirrors chalk's own `hexToRgb`, which is deliberately *unanchored* — it
// scans the string for the first 6-run (preferred) or 3-run of hex digits
// anywhere inside it, rather than requiring the whole string to be a clean
// hex color. See node_modules/chalk/source/vendor/ansi-styles/index.js:136
// (chalk@5.6.2): `/[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16))`. Re-check
// this against that file if chalk is ever upgraded.
const CHALK_HEX = /[a-f\d]{6}|[a-f\d]{3}/i;

/**
 * Normalize a color string the way chalk's `hex()`/`bgHex()` actually resolve
 * it: find the first embedded 6-digit (or 3-digit) hex run per chalk's own
 * unanchored regex, expand a 3-digit match to 6, lowercase it, and collapse
 * anything with no such run (named colors, empty strings, garbage) to the
 * same black chalk paints for those inputs. Because the match is unanchored,
 * inputs like "#abcd" or "#12345" resolve to a real color ("#aabbcc",
 * "#112233") rather than black — that mirrors chalk exactly, even though it
 * looks surprising next to a naive anchored implementation.
 */
export function normalizeColor(color: string): string {
  const match = CHALK_HEX.exec(color);
  if (!match) return "#000000";
  let digits = match[0].toLowerCase();
  if (digits.length === 3) {
    digits = [...digits].map((c) => c + c).join("");
  }
  return `#${digits}`;
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/** sRGB hex -> CIE L*a*b* (D65 white point). */
function hexToLab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);

  // sRGB D65 -> XYZ, then scaled by the D65 white point.
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;

  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * CIEDE2000 perceptual difference between two colors, after resolving each to
 * the color chalk would actually paint for it.
 *
 * Why CIEDE2000 and not a WCAG contrast ratio: WCAG contrast measures
 * luminance only, for text legibility against a background. It is not a
 * measure of whether two adjacent color patches are distinguishable — purple
 * beside teal scores 1.05:1 by WCAG while being obviously different colors.
 * See the issue #40 design spec for the measurements.
 *
 * Roughly: 0 identical, ~1 a just-noticeable difference, >10 clearly distinct.
 */
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(normalizeColor(a));
  const [l2, a2, b2] = hexToLab(normalizeColor(b));

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * DEG + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * DEG + 360) % 360;

  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  // Hue difference wraps at 0/360; chroma of zero means hue is undefined.
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * RAD) / 2);

  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;

  let hBarP: number;
  if (c1p * c2p === 0) {
    hBarP = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarP = (h1p + h2p) / 2;
  } else {
    hBarP = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * RAD) +
    0.24 * Math.cos(2 * hBarP * RAD) +
    0.32 * Math.cos((3 * hBarP + 6) * RAD) -
    0.2 * Math.cos((4 * hBarP - 63) * RAD);

  const sL = 1 + (0.015 * Math.pow(lBarP - 50, 2)) / Math.sqrt(20 + Math.pow(lBarP - 50, 2));
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;

  const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
  const rC = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const rT = -Math.sin(2 * dTheta * RAD) * rC;

  return Math.sqrt(
    Math.pow(dLp / sL, 2) +
      Math.pow(dCp / sC, 2) +
      Math.pow(dHp / sH, 2) +
      rT * (dCp / sC) * (dHp / sH),
  );
}
```

- [ ] **Step 2: Verify against an independent implementation — do NOT skip or shortcut this**

CIEDE2000 has two well-known implementation traps: the hue-average branch across the 0°/360° boundary, and the `rT` rotation term. A wrong implementation returns *plausible* numbers, not obvious garbage. So the expected values in the committed test must come from somewhere other than our own code.

Install a reference implementation as a throwaway — **not** a project dependency:

```bash
mkdir -p /tmp/ciede-check && cd /tmp/ciede-check && npm init -y >/dev/null && npm install culori >/dev/null 2>&1
```

`culori` exposes `differenceCiede2000()`, which returns a comparison function, and `parse()` for hex strings. Check the installed package's own docs/typings before writing the script — if the API differs from that, adapt and say so in your report. If `culori` cannot be installed or its API is unclear, `color-diff` (`getDeltaE00`) is an acceptable alternative; report which you used.

Write a differential script that compares our implementation against the reference across:

- every color pair named in the spec's tables
- at least 5,000 randomly generated hex pairs
- **at least 500 pairs drawn from the red/magenta region** (hue near 0°/360°, e.g. both colors with `r` high and `g`/`b` low), which is what exposes the hue-wraparound bug specifically
- pairs where one or both colors are pure greys (`#000000`, `#808080`, `#ffffff`) — these have chroma 0 and exercise the undefined-hue branch

Report the maximum absolute divergence. Anything above `1e-6` means our implementation is wrong — fix it before continuing, and say so in your report.

- [ ] **Step 3: Re-verify the spec's measured values against the reference**

The threshold `MIN_SEPARATOR_DELTA = 8` was chosen from ΔE values that were measured with a draft of *our* implementation, so they inherit its correctness. Confirm them against the reference from Step 2:

| pair | expected ΔE2000 |
|---|---|
| `#a67c00` / `#b8860b` | 4.61 |
| `#c01c28` / `#a01822` | 6.54 |
| `#26a269` / `#2ec27e` | 9.14 |
| `#613583` / `#7d4fa8` | 9.63 |
| `#7d4fa8` / `#0d7377` | 32.21 |

**If any of these differs from the reference by more than 0.1, STOP and report it rather than adjusting anything.** The choice of 8 depends on 6.54 sitting below it and 9.14 above it; if those move, the threshold needs re-deciding and that is not your call.

- [ ] **Step 4: Write the test file using the reference values**

Create `src/__tests__/color-compare.test.ts`.

First, **move** the existing `describe("normalizeColor", ...)` block from `src/__tests__/renderer.test.ts` (lines 327-357, running to the end of that file) into the new file verbatim — including its comment about values being measured against chalk rather than re-derived. Those tests belong with the module they exercise. Then remove `normalizeColor` from `renderer.test.ts`'s import on line 3, leaving `import { layoutPowerline } from "../render/powerline.js";`.

Then add the `colorDistance` block below it. Fill the `REFERENCE` table with the values **your Step 2 reference implementation produced**, to 4 decimal places — not values produced by `colorDistance`.

The table is deliberately left empty in this plan rather than pre-filled: any value written here would have come from the draft implementation, which is exactly the self-verification the spec forbids. Filling it from the reference is part of the task, not a gap in the plan.

Include the four spec pairs plus at least six more spanning greys, near-hue-wraparound reds, and high-chroma pairs.

```ts
import { describe, it, expect } from "vitest";
import { colorDistance, normalizeColor } from "../render/color-compare.js";

// ... the moved describe("normalizeColor", ...) block goes here ...

describe("colorDistance", () => {
  // Expected values come from `culori`'s differenceCiede2000 (see the plan's
  // Task 1 Step 2), NOT from this implementation. CIEDE2000's hue-average and
  // rotation terms are easy to get subtly wrong in ways that still produce
  // plausible numbers, so self-derived expectations would lock in a bug.
  const REFERENCE: Array<[string, string, number]> = [
    // FILL FROM THE REFERENCE IMPLEMENTATION — 4 decimal places.
    // Must include: #a67c00/#b8860b, #c01c28/#a01822, #26a269/#2ec27e,
    // #613583/#7d4fa8, at least two grey pairs, and at least two red pairs
    // whose hues straddle 0/360.
  ];

  it("matches the reference implementation", () => {
    for (const [a, b, expected] of REFERENCE) {
      expect(colorDistance(a, b), `${a} vs ${b}`).toBeCloseTo(expected, 3);
    }
  });

  it("is zero for identical colors", () => {
    expect(colorDistance("#a67c00", "#a67c00")).toBe(0);
    expect(colorDistance("#000000", "#000000")).toBe(0);
  });

  it("is symmetric", () => {
    expect(colorDistance("#a67c00", "#b8860b")).toBeCloseTo(
      colorDistance("#b8860b", "#a67c00"),
      10,
    );
  });

  it("normalizes before comparing, so equivalent spellings are identical", () => {
    expect(colorDistance("#fff", "#ffffff")).toBe(0);
    expect(colorDistance("#ABC", "#aabbcc")).toBe(0);
    // chalk paints both of these black.
    expect(colorDistance("red", "")).toBe(0);
  });
});
```

- [ ] **Step 5: Point `powerline.ts` at the new module**

In `src/render/powerline.ts`, delete the `CHALK_HEX` constant (line 28), its comment block (lines 22-27), and the `normalizeColor` function (lines 30-50). Add to the imports at the top:

```ts
import { normalizeColor } from "./color-compare.js";
```

`sameColor` at lines 52-54 stays for now, still calling `normalizeColor` — Task 2 replaces it.

`powerline.ts` no longer re-exports `normalizeColor`; nothing should import it from there. `renderer.test.ts` stopped needing it in Step 4. Update `src/__tests__/defaults.test.ts:4`, which currently reads:

```ts
import { layoutPowerline, normalizeColor } from "../render/powerline.js";
```

to:

```ts
import { layoutPowerline } from "../render/powerline.js";
import { normalizeColor } from "../render/color-compare.js";
```

(Task 3 removes that `normalizeColor` usage entirely; for now the file still needs it.)

Confirm with `grep -rn "normalizeColor" src/` that the only import path in use is `color-compare.js`, then run `npm run typecheck`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/__tests__/color-compare.test.ts`
Expected: PASS — all four `describe` blocks.

Run: `npm test && npm run typecheck`
Expected: both PASS. Nothing else changed behavior yet, so the existing 141 tests must all still pass.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/render/color-compare.ts src/__tests__/color-compare.test.ts \
        src/render/powerline.ts src/__tests__/renderer.test.ts src/__tests__/defaults.test.ts
git add -f dist/index.js
git commit -m "Add color-compare module with CIEDE2000 distance (#40)

Moves normalizeColor out of powerline.ts, which should be about layout, and
adds colorDistance — a CIEDE2000 perceptual difference computed over
normalized inputs.

CIEDE2000 rather than a WCAG contrast ratio because WCAG measures luminance
only, for text legibility. It is not a measure of whether two adjacent color
patches are distinguishable: purple beside teal scores 1.05:1 by WCAG and
dE 32 perceptually.

Expected values in the tests come from an independent implementation, not
from this one — the hue-average and rotation terms are easy to get subtly
wrong in ways that still return plausible numbers.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Switch the separator rule to a distance threshold

**Files:**
- Modify: `src/render/powerline.ts` (remove `sameColor`; add `MIN_SEPARATOR_DELTA`; change the separator decision at lines 86-96)
- Modify: `src/__tests__/renderer.test.ts` (add cases to the existing `describe("layoutPowerline", ...)` block)
- Modify: `README.md` (the "Separators" section added by PR #39)

**Interfaces:**
- Consumes: `colorDistance(a: string, b: string): number` from `src/render/color-compare.js` (Task 1).
- Produces: `export const MIN_SEPARATOR_DELTA = 8` from `src/render/powerline.ts` — Task 3's sweep binds to it.

---

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("layoutPowerline", ...)` block in `src/__tests__/renderer.test.ts`. That block already defines `const OPTIONS = { theme: "default", separator: "▶", separatorThin: "│" }` — reuse it.

```ts
  // The wide glyph is painted in the previous segment's bg over this one's, so
  // near-identical backgrounds make it unreadable even though they differ.
  // Below MIN_SEPARATOR_DELTA the thin glyph is used instead. Measured ΔE2000
  // for each pair is in the comment; the two above-threshold cases are the
  // regression guard on the constant. See issue #40.
  it("draws the thin separator when backgrounds are perceptually close", () => {
    // ΔE 4.61 — context-percent warn beside compact-countdown warn.
    const warn = layoutPowerline(
      [
        { text: "70%", fg: "#ffffff", bg: "#a67c00" },
        { text: "~28k left", fg: "#ffffff", bg: "#b8860b" },
      ],
      OPTIONS,
    );
    expect(warn[1]).toEqual({ text: "│", fg: "#ffffff", bg: "#b8860b" });

    // ΔE 6.54 — context-percent danger beside compact-countdown danger.
    const danger = layoutPowerline(
      [
        { text: "95%", fg: "#ffffff", bg: "#c01c28" },
        { text: "Compact imminent!", fg: "#ffffff", bg: "#a01822" },
      ],
      OPTIONS,
    );
    expect(danger[1]).toEqual({ text: "│", fg: "#ffffff", bg: "#a01822" });
  });

  it("keeps the wide separator for backgrounds just above the threshold", () => {
    // ΔE 9.14 — today-spend beside vim-mode NORMAL, in the shipped defaults.
    const vim = layoutPowerline(
      [
        { text: "Today: $3.00", fg: "#ffffff", bg: "#26a269" },
        { text: "NORMAL", fg: "#ffffff", bg: "#2ec27e" },
      ],
      OPTIONS,
    );
    expect(vim[1]).toEqual({ text: "▶", fg: "#26a269", bg: "#2ec27e" });

    // ΔE 9.63 — git-branch beside git-changes, in the shipped defaults.
    const git = layoutPowerline(
      [
        { text: "main", fg: "#ffffff", bg: "#613583" },
        { text: "+2 ~1", fg: "#ffffff", bg: "#7d4fa8" },
      ],
      OPTIONS,
    );
    expect(git[1]).toEqual({ text: "▶", fg: "#613583", bg: "#7d4fa8" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: FAIL on `"draws the thin separator when backgrounds are perceptually close"` — both assertions get `{ text: "▶", fg: <prev bg>, ... }` because the current rule only catches exact equality. The second new test should already PASS (those pairs get the wide glyph today and must keep it).

- [ ] **Step 3: Switch the rule**

In `src/render/powerline.ts`, replace the `sameColor` function (lines 52-54) with the threshold constant:

```ts
/**
 * Below this CIEDE2000 distance two backgrounds are too close for the wide
 * glyph — painted in the previous segment's bg — to read against the incoming
 * one. Exact matches (ΔE 0) are the degenerate case. Measured across every
 * adjacent pair reachable in the shipped defaults, the nearest values either
 * side of this are 6.54 and 9.14, so the exact constant is not delicate.
 * See the issue #40 design spec.
 */
export const MIN_SEPARATOR_DELTA = 8;
```

Removing `sameColor` leaves `normalizeColor` unused in this file — `colorDistance` normalizes internally. So the Task 1 import is **replaced**, not extended:

```ts
import { colorDistance } from "./color-compare.js";
```

Confirm with `npm run typecheck` that no unused import remains.

Then change the separator decision (lines 86-96). Replace `sameColor(prev.bg, bg)` with `colorDistance(prev.bg, bg) < MIN_SEPARATOR_DELTA`, and update the leading comment block (lines 75-85) so it describes perceptual closeness rather than exact matching — keep the existing explanation of the whitespace/empty `separatorThin` fallback intact, it is unrelated and still correct:

```ts
    // The wide separator is painted in the previous segment's bg over this
    // segment's bg, so when those are the same — or merely too close to tell
    // apart — it does not read and the two segments look like one block.
    // Widgets pick their bg from thresholds at render time, so this is
    // reachable in the shipped defaults: context-percent and compact-countdown
    // sit next to each other with alert shades ΔE 4.61 apart. Fall back to the
    // thin separator, drawn in the previous segment's fg. See issues #36, #40.
    // A whitespace-only separatorThin (e.g. " ") is truthy but has no ink, so
    // it merges the segments just like the empty string would — fall back to
    // the wide glyph in that case too. If both separator and separatorThin
    // are blank, there's nothing to draw either way; we draw the (blank)
    // wide one rather than special-casing it further.
    if (prev !== null) {
      pieces.push(
        colorDistance(prev.bg, bg) < MIN_SEPARATOR_DELTA
          ? {
              text: options.separatorThin.trim() ? options.separatorThin : options.separator,
              fg: prev.fg,
              bg,
            }
          : { text: options.separator, fg: prev.bg, bg },
      );
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: PASS — both new tests, plus every pre-existing `layoutPowerline` case. The exact-match, `#fff`/`#ffffff`, whitespace-fallback, single-segment, empty-input and theme-fallback tests must all still pass unchanged; identical colors give ΔE 0, which is below the threshold, so they still take the thin path.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both PASS. `defaults.test.ts` still passes here — its assertion is unchanged until Task 3.

- [ ] **Step 6: Verify against the real binary**

```bash
npm run build
rm -f ~/.cache/gccusage/statusline-cache.json

# Both amber: ΔE 4.61, previously an unreadable seam.
echo '{"session_id":"a","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":2.10},"context_window":{"used_percentage":72,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v

# Both red: ΔE 6.54.
echo '{"session_id":"b","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":2.10},"context_window":{"used_percentage":95,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v

# Healthy bar: no boundary below ΔE 8, so every separator must still be the wide glyph.
echo '{"session_id":"c","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":2.10},"context_window":{"used_percentage":30,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v
```

Expected: a `│` (bytes `e2 94 82`) between the two amber segments in the first, and between the two red segments in the second. The third must contain **no** `│` at all — only `▶` (bytes `e2 96 b6`). Paste all three into your report.

- [ ] **Step 7: Update the README**

PR #39 added a "Separators" section after the "Available themes" line. Its second paragraph currently begins "When two neighbouring segments resolve to the same background". Replace that paragraph with:

```markdown
`separator` is drawn between segments of different colors. When two neighbouring
segments resolve to backgrounds that are the same — or too close to tell apart,
which happens when, say, context usage and the compact countdown both cross their
warning thresholds — the wide glyph would not read against them, so `separatorThin`
is drawn in the previous segment's text color instead.
```

- [ ] **Step 8: Commit**

```bash
npm run build
git add src/render/powerline.ts src/__tests__/renderer.test.ts README.md
git add -f dist/index.js
git commit -m "Use a perceptual distance threshold for the thin separator (#40)

PR #39 made the separator visible when two adjacent segments resolved to the
identical background. The invariant it encoded was exact equality, not
visibility: backgrounds a few perceptual steps apart still produce a glyph
that is drawn and unreadable, and nothing detected it.

Two such pairs ship in the defaults, both where compact-countdown's bespoke
alert shades sit beside context-percent's: dE 4.61 when both warn, dE 6.54
when both hit danger. The second is not transient — a session past 90%
context stays there.

The rule becomes colorDistance(prevBg, bg) < 8, which strictly generalizes
the old one since identical colors give dE 0. Measured over all 31 adjacent
background pairs reachable in the defaults, this changes exactly two
boundaries and leaves the healthy bar untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Tighten the defaults sweep to a distance floor

**Files:**
- Modify: `src/__tests__/defaults.test.ts` (import at line 4; the comment at lines 137-142 and the assertion at lines 159-165 inside `assertEveryPieceVisible`)

**Interfaces:**
- Consumes: `colorDistance` from `src/render/color-compare.js` (Task 1), `MIN_SEPARATOR_DELTA` from `src/render/powerline.js` (Task 2).
- Produces: nothing consumed downstream.

**Why:** the sweep currently asserts each piece's `fg` differs from its own `bg` after normalization. That is the same exact-equality predicate the renderer just stopped using — it would pass a separator drawn `#a67c00` on `#b8860b`. Raising it to the same distance floor the renderer enforces makes it hold *by construction* (a wide separator is only emitted at or above the threshold; a thin one is a light fg on a dark bg), which is what makes it a regression guard rather than a restatement.

---

- [ ] **Step 1: Update the import**

After Task 1, `src/__tests__/defaults.test.ts` imports look like:

```ts
import { layoutPowerline } from "../render/powerline.js";
import { normalizeColor } from "../render/color-compare.js";
```

Replace both with:

```ts
import { layoutPowerline, MIN_SEPARATOR_DELTA } from "../render/powerline.js";
import { colorDistance } from "../render/color-compare.js";
```

`normalizeColor` is no longer used in this file after Step 2 — confirm with `grep -n normalizeColor src/__tests__/defaults.test.ts` that no reference remains, and that `npm run typecheck` reports no unused import.

- [ ] **Step 2: Raise the assertion to the distance floor**

Replace the comment block at lines 137-142 and the second `expect` inside `assertEveryPieceVisible` (lines 159-165). The first `expect` — the `piece.text.trim()` ink check — stays exactly as it is.

```ts
  // The renderer paints separators and segment text from the same resolved
  // {fg, bg} model, so one predicate covers both: a piece whose fg is too
  // close to its own bg is unreadable — an illegible segment, or a seam that
  // makes two segments look like one block. The floor is the same constant
  // the renderer uses to choose a separator, so this holds by construction
  // and fails the moment either side drifts. Exact equality is not enough:
  // "#a67c00" on "#b8860b" are different colors and still unreadable (#40).
```

```ts
      if (piece.bg === undefined) continue;
      const distance = colorDistance(piece.fg, piece.bg);
      expect(
        distance,
        `[${mode}] "${piece.text}" is unreadable: fg ${piece.fg} is only ` +
          `ΔE ${distance.toFixed(2)} from bg ${piece.bg} (floor ${MIN_SEPARATOR_DELTA}) at ` +
          `used_percentage=${point.used}, sessionCostUsd=${point.session}, ` +
          `todayCostUsd=${point.today}, vim=${point.vim}. Segments: ${order}`,
      ).toBeGreaterThanOrEqual(MIN_SEPARATOR_DELTA);
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/defaults.test.ts`
Expected: PASS, all 162 sweep points, in both `line` and `compact` mode.

If this fails, do not weaken the assertion — report the failing piece. A failure means some segment in the shipped defaults has text that is genuinely hard to read against its own background, which is a real finding.

- [ ] **Step 4: Prove the tightened sweep has teeth**

The old assertion would pass a `#a67c00`-on-`#b8860b` separator; the new one must not. Confirm the sweep now catches what the renderer protects against, by temporarily reverting the renderer to exact matching.

In `src/render/powerline.ts`, change:

```ts
        colorDistance(prev.bg, bg) < MIN_SEPARATOR_DELTA
```

to:

```ts
        colorDistance(prev.bg, bg) === 0
```

Run: `npx vitest run src/__tests__/defaults.test.ts`

Expected: **FAIL**, with a message naming an unreadable separator at ΔE 4.61 between `#a67c00` and `#b8860b`, at a sweep point with `used_percentage` in the 70–75 range.

Record the verbatim failure message in your report, then **revert the edit** (`git checkout src/render/powerline.ts`) and re-run to confirm PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/defaults.test.ts
git commit -m "Raise the defaults sweep to the renderer's distance floor (#40)

The sweep asserted each piece's fg differed from its own bg after
normalization — the same exact-equality predicate the renderer just stopped
using. It would have passed a separator drawn #a67c00 on #b8860b.

It now asserts the same ΔE floor the renderer enforces, so the guard holds by
construction and fails the moment either side drifts.

Verified the tightened sweep fails when the renderer is reverted to exact
matching.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Note: this task touches only a test file, so `dist/index.js` is unchanged. Confirm with `git status` that it is not listed as modified before committing.

---

## Task 4: Ship it

**Files:** none modified — branch, PR, and issue mechanics.

**Interfaces:**
- Consumes: the three commits from Tasks 1-3, plus the spec commit `a285e25` already on the branch.
- Produces: a pull request, and a corrected issue #40 body.

---

- [ ] **Step 1: Confirm the tree is clean and the build is current**

```bash
npm test && npm run typecheck && npm run build && git status --short
```

Expected: tests and typecheck PASS, and `git status --short` prints nothing. If `dist/index.js` shows as modified, an earlier commit staged a stale bundle — fix before proceeding.

- [ ] **Step 2: Push the branch**

```bash
git rev-parse --abbrev-ref HEAD   # expect: fix-40-perceptual-separator-threshold
git push -u origin fix-40-perceptual-separator-threshold
```

- [ ] **Step 3: Correct the issue #40 body**

The issue was filed using the WCAG contrast ratio, which measures luminance only and is meant for text legibility rather than for whether two adjacent color patches are distinguishable. It concluded that 4 of 8 boundaries were affected, worst `git-changes` ▶ `lines-changed` at 1.051:1 — a pair that is ΔE 32.2 apart and among the *most* distinguishable in the bar.

Leaving that published would misdirect anyone who picks the issue up. Rewrite the body with `gh issue edit 40 --body-file <file>`, keeping the same structure but:

- replacing the WCAG table with the ΔE2000 measurements from the design spec's "Correction" section
- narrowing the claim from "4 of 8 boundaries in the default healthy state" to the two alert-state pairs (ΔE 4.61 and 6.54)
- keeping an explicit note that the original analysis used the wrong metric, so the correction is visible rather than silently swapped
- keeping the three directions, marking direction 2 as the one being implemented

- [ ] **Step 4: Open the pull request**

```bash
gh pr create --title "Use a perceptual distance threshold for the thin separator (#40)" --body "$(cat <<'EOF'
Closes #40. Stacked on #39 — merge that first.

## Problem

#39 made the separator visible when two adjacent segments resolve to the
**identical** background. The invariant it encoded is exact equality, not
visibility: backgrounds a few perceptual steps apart still produce a glyph that
is drawn and unreadable, and nothing detects it.

Two such pairs ship in the defaults, both where `compact-countdown`'s bespoke
alert shades sit beside `context-percent`'s:

| state | context-percent | compact-countdown | ΔE2000 |
|---|---|---|---|
| both warning (usage 70–75.1%) | `#a67c00` | `#b8860b` | 4.61 |
| both danger (usage ≥ 90%) | `#c01c28` | `#a01822` | 6.54 |

The second is not transient — a session past 90% context stays there.

## Correcting the issue as filed

#40 measured these boundaries with the **WCAG contrast ratio** and concluded 4 of
8 boundaries were affected, worst `git-changes` ▶ `lines-changed` at 1.051:1.

That was the wrong metric. WCAG contrast measures luminance only, for text
legibility against a background; it says nothing about whether two adjacent color
patches are distinguishable. `git-changes` purple beside `lines-changed` teal
scores 1.051 by WCAG and **32.21** by ΔE2000 — one of the most distinguishable
boundaries in the bar, not the worst.

The genuinely close pairs are the two alert-state ones above, which is what the
#39 code review originally flagged. The issue body has been corrected.

## The threshold

Enumerating every adjacent background pair reachable in `DEFAULT_SETTINGS` —
sweeping context usage, session cost, daily spend and vim mode, reading pairs
straight out of `layoutPowerline` — gives 31 distinct pairs:

```
  0.00  #a67c00 | #a67c00     already thin (exact match)
  0.00  #c01c28 | #c01c28     already thin (exact match)
  4.61  #a67c00 | #b8860b     NEW -> thin
  6.54  #c01c28 | #a01822     NEW -> thin
  ------------- threshold: ΔE 8 -------------
  9.14  #26a269 | #2ec27e     stays wide
  9.63  #613583 | #7d4fa8     stays wide
        ... 25 more, all above 15 ...
```

Exactly two boundaries change, both alert-only; the healthy bar is untouched. The
constant is not delicate — nearest reachable values are 6.54 below and 9.14 above.

A WCAG-style 3:1 floor was rejected: no boundary in the default layout reaches
1.94:1, so every separator would go thin and the powerline arrow would vanish
from the bar entirely.

## Implementation

New `src/render/color-compare.ts` owns comparing colors as values —
`normalizeColor` moves there out of `powerline.ts`, joined by `colorDistance`
(CIEDE2000 over normalized inputs). The rule becomes
`colorDistance(prevBg, bg) < MIN_SEPARATOR_DELTA`, which strictly generalizes
#39: identical colors give ΔE 0, so that path is unchanged.

**The CIEDE2000 expected values in the tests come from an independent
implementation, not from ours.** The hue-average branch across 0°/360° and the
`rT` rotation term are easy to get subtly wrong in ways that still return
plausible numbers, so self-derived expectations would have locked a bug in.

The defaults sweep moves from "fg differs from bg" to the same ΔE floor the
renderer enforces, so it holds by construction and fails if either side drifts.
Verified it fails when the renderer is reverted to exact matching.

## Not in scope

- No widget colors change. Retiring `compact-countdown`'s bespoke shades so the
  alert states collide exactly was direction 3 on the issue.
- No configurable threshold — a knob almost nobody can reason about, and the
  measured margin means one constant serves every reachable state.
- The alert palette is still not centralized (#36's third point stays open).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Verify the PR contents**

Run: `gh pr view --json files -q '.files[].path'`

Expected: `README.md`, `dist/index.js`, `src/__tests__/color-compare.test.ts`, `src/__tests__/defaults.test.ts`, `src/__tests__/renderer.test.ts`, `src/render/color-compare.ts`, `src/render/powerline.ts`, plus the two docs under `docs/superpowers/`. **No file under `src/widgets/`.** If `dist/index.js` is missing, the bundle was not staged.

Note: because this branch is stacked on `fix-36-powerline-thin-separator`, the PR will show that branch's commits too until #39 merges. Set the PR base to `fix-36-powerline-thin-separator` if the repo supports stacked review, otherwise leave it against `main` and note the dependency in the description (already noted).

---

## Verification Checklist

- [ ] `npm test` passes; `npm run typecheck` clean
- [ ] `colorDistance` agrees with an independent CIEDE2000 implementation to within 1e-6 across ≥5,000 random pairs, ≥500 near-hue-wraparound reds, and grey pairs
- [ ] The five spec ΔE values re-confirmed against that reference to within 0.1
- [ ] No expected ΔE value in any committed test was produced by our own implementation
- [ ] Reverting the renderer to exact matching makes `defaults.test.ts` fail with a named ΔE 4.61 collision
- [ ] At 72% and 95% usage the built binary emits `│`; at 30% it emits none
- [ ] `dist/index.js` staged in every commit that touches `src/`
- [ ] No widget file in the diff
- [ ] Issue #40's body corrected to drop the WCAG analysis
