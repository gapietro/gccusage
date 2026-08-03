# Display Width Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure terminal columns instead of UTF-16 code units, so a bar containing CJK, emoji or accented text stops overflowing and wrapping.

**Architecture:** A new `src/utils/display-width.ts` owns all Unicode reasoning — `Intl.Segmenter` for grapheme cluster boundaries, `get-east-asian-width` for the per-cluster column count. `terminal.ts`'s existing `visibleLength` delegates to it, so the four render-path call sites inherit the fix without import changes. `truncation.ts` and `shrink.ts` additionally walk by cluster instead of by UTF-16 unit / code point.

**Tech Stack:** TypeScript, tsdown, vitest, `get-east-asian-width` (new runtime dependency), `Intl.Segmenter` (built into Node).

**Spec:** `docs/superpowers/specs/2026-08-02-display-width-design.md`
**Issue:** [#86](https://github.com/gapietro/gccusage/issues/86) (audit finding COR-003, P2)

## Global Constraints

- **Ambiguous-width characters count as 1 column.** Pass `{ ambiguousAsWide: false }` **explicitly** to `eastAsianWidth` — never rely on the package default. Its runtime default is narrow but its own JSDoc declares `@default true`, so a future version aligning code to docs would silently double-count `▶`, `…`, `│` and the powerline glyphs, which are all Ambiguous.
- **Every existing width measurement must stay byte-identical.** `src/__tests__/default-layout-width.test.ts` asserts exact figures (88 at line 148, `SUPPORTED_WIDTH` = 80 at line 167, 79 at line 181). If any of them shifts, the Ambiguous policy is wrong — **stop and report; do not update the expectation.**
- **Every commit touching `src/` must rebuild and stage the bundle.** `npm run build`, then `git add -f dist/index.js`. It is gitignored but force-tracked, and CI's `bundle-drift` job fails otherwise. A src-only commit leaves `git pull` upgraders running the old code.
- **Verify every new test by breaking what it guards.** A test that passes on first run and cannot be made to fail is not evidence. This repo has a documented history of vacuous tests.
- **`src/` imports use the `.js` extension** (tsdown rewrites specifiers). Never `.ts` — that convention applies only to `scripts/`.
- Node floor is `>=22`. `Intl.Segmenter` needs full ICU, which Node ships by default.

---

### Task 1: The display-width module

Self-contained new unit with no callers yet, so nothing can regress. Adds the dependency.

**Files:**
- Create: `src/utils/display-width.ts`
- Create: `src/__tests__/display-width.test.ts`
- Modify: `package.json` (add dependency)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `splitGraphemes(str: string): string[]`, `graphemeWidth(cluster: string): number`, `displayWidth(str: string): number` — all from `src/utils/display-width.ts`. Tasks 2, 3 and 4 import these.

- [ ] **Step 1: Add the dependency**

```bash
npm install get-east-asian-width@^1.6.0
```

It is zero-dependency, pure ESM, ~14.6 KB unpacked. This is the third runtime dependency alongside `chalk` and `valibot`.

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/display-width.test.ts`. Every figure below was measured against the real package while writing the spec — they are not derived from memory of the Unicode tables.

```ts
import { describe, it, expect } from "vitest";
import { displayWidth, graphemeWidth, splitGraphemes } from "../utils/display-width.js";

describe("displayWidth", () => {
  it("counts ASCII one column per character", () => {
    expect(displayWidth("Opus 4.6")).toBe(8);
    expect(displayWidth("")).toBe(0);
  });

  it("counts East Asian wide characters as two columns", () => {
    expect(displayWidth("日本語")).toBe(6);
    // The exact project name from issue #86: 17 glyphs, 34 columns, but
    // String.length reports 17 — the whole defect in one assertion.
    expect(displayWidth("日本語プロジェクト名前テストの長い")).toBe(34);
    expect("日本語プロジェクト名前テストの長い".length).toBe(17);
  });

  it("counts fullwidth forms as two columns", () => {
    expect(displayWidth("ＡＢ")).toBe(4);
  });

  it("counts an accented letter as one column, composed or decomposed", () => {
    expect(displayWidth("é")).toBe(1); // e + COMBINING ACUTE
    expect(displayWidth("é")).toBe(1); // precomposed é — also Ambiguous
  });

  it("counts a regional-indicator flag as two columns", () => {
    // Regional Indicators are East_Asian_Width=Neutral, so the base code point
    // alone yields 1. The explicit RI rule is what makes this 2.
    expect(displayWidth("\u{1F1EF}\u{1F1F5}")).toBe(2); // 🇯🇵
    expect(displayWidth("\u{1F1EF}\u{1F1F5}\u{1F1FA}\u{1F1F8}")).toBe(4); // 🇯🇵🇺🇸
  });

  it("counts a ZWJ family emoji as two columns", () => {
    expect(displayWidth("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(2); // 👨‍👩‍👧
  });

  it("counts an emoji-presentation sequence as two columns", () => {
    // U+2764 is Ambiguous (1); VS16 requests the two-column emoji presentation.
    expect(displayWidth("❤️")).toBe(2); // ❤️
  });
});

describe("ambiguous-width policy", () => {
  // Every decorative glyph the bar draws is East_Asian_Width=Ambiguous.
  // Treating Ambiguous as wide would double-count all of them and shift every
  // measurement in the renderer. UAX #11 says default to narrow where context
  // cannot be established, which is our situation.
  it.each([
    ["default separator U+25B6", "▶"],
    ["ellipsis U+2026", "…"],
    ["thin separator U+2502", "│"],
    ["powerline separator U+E0B0", ""],
    ["branch glyph U+E0A0", ""],
  ])("measures the %s as one column", (_name, glyph) => {
    expect(displayWidth(glyph)).toBe(1);
  });
});

describe("splitGraphemes", () => {
  it("keeps a ZWJ sequence in a single cluster", () => {
    expect(splitGraphemes("a\u{1F468}‍\u{1F469}‍\u{1F467}b")).toEqual([
      "a",
      "\u{1F468}‍\u{1F469}‍\u{1F467}",
      "b",
    ]);
  });

  it("keeps a combining mark with its base", () => {
    expect(splitGraphemes("éx")).toEqual(["é", "x"]);
  });

  it("keeps a flag's two regional indicators in one cluster", () => {
    expect(splitGraphemes("\u{1F1EF}\u{1F1F5}")).toEqual(["\u{1F1EF}\u{1F1F5}"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(splitGraphemes("")).toEqual([]);
  });
});

describe("graphemeWidth", () => {
  it("returns 0 for the empty string", () => {
    expect(graphemeWidth("")).toBe(0);
  });

  it("returns 1 for a narrow cluster", () => {
    expect(graphemeWidth("a")).toBe(1);
  });

  it("returns 2 for a wide cluster", () => {
    expect(graphemeWidth("日")).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/display-width.test.ts`
Expected: FAIL — cannot resolve `../utils/display-width.js`.

- [ ] **Step 4: Write the implementation**

Create `src/utils/display-width.ts`:

```ts
import { eastAsianWidth } from "get-east-asian-width";

/**
 * Grapheme cluster boundaries, per UAX #29.
 *
 * Constructed once at module scope: building an `Intl.Segmenter` is the
 * expensive part, segmenting with it is not. Grapheme segmentation is
 * locale-independent per the spec; `"en"` is passed rather than `undefined`
 * so the result cannot drift with the host machine's default locale.
 */
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** VARIATION SELECTOR-16 — requests the two-column emoji presentation. */
const VS16 = "️";

/** REGIONAL INDICATOR SYMBOL LETTER A .. Z — two of these make a flag. */
const REGIONAL_INDICATOR_FIRST = 0x1f1e6;
const REGIONAL_INDICATOR_LAST = 0x1f1ff;

/** `str` split into grapheme clusters — what a reader would call "characters". */
export function splitGraphemes(str: string): string[] {
  const clusters: string[] = [];
  for (const { segment } of segmenter.segment(str)) clusters.push(segment);
  return clusters;
}

/**
 * Terminal columns occupied by ONE grapheme cluster.
 *
 * Width comes from the cluster's FIRST code point: a ZWJ family's base is
 * `👨` (wide), a decomposed `é`'s base is `e` (narrow), and the trailing
 * combining marks, joiners and variation selectors cost nothing because they
 * sit inside the cluster rather than being separate iterations.
 *
 * Two exceptions are applied before the table lookup, both measured against
 * the package rather than reasoned about:
 *
 * - A cluster containing VS16 counts 2. `❤️` is U+2764, East_Asian_Width
 *   Ambiguous and therefore 1 on its own, but the selector requests the
 *   emoji presentation and terminals draw that at two columns.
 * - A cluster led by a Regional Indicator counts 2. Regional Indicators are
 *   East_Asian_Width **Neutral**, so `🇯🇵` measures 1 from its base code point
 *   alone, while every terminal draws a flag at two columns.
 *
 * `ambiguousAsWide: false` is passed EXPLICITLY and must stay that way. The
 * package's runtime default is narrow, but its own JSDoc declares
 * `@default true`; a release that aligned the code to its documentation would
 * otherwise silently double-count `▶`, `…`, `│` and the powerline glyphs,
 * which are all Ambiguous, and shift every measurement in the bar.
 */
export function graphemeWidth(cluster: string): number {
  if (cluster === "") return 0;
  if (cluster.includes(VS16)) return 2;
  const codePoint = cluster.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= REGIONAL_INDICATOR_FIRST && codePoint <= REGIONAL_INDICATOR_LAST) {
    return 2;
  }
  return eastAsianWidth(codePoint, { ambiguousAsWide: false });
}

/**
 * Terminal columns `str` occupies.
 *
 * Input must already be free of ANSI escapes — this counts what it is given.
 * `visibleLength` in `terminal.ts` is the ANSI-aware entry point.
 */
export function displayWidth(str: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(str)) width += graphemeWidth(segment);
  return width;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/display-width.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Sabotage-check the two exception rules**

These two rules are the ones a future reader is most likely to think are redundant, so prove they are load-bearing.

1. Delete the `if (cluster.includes(VS16)) return 2;` line. Run the test. Expected: the `❤️` case fails with `expected 2, received 1`. Restore it.
2. Delete the Regional Indicator branch. Run the test. Expected: both flag cases fail (`🇯🇵` → 1, `🇯🇵🇺🇸` → 2). Restore it.
3. Change `ambiguousAsWide: false` to `true`. Run the test. Expected: all five ambiguous-policy cases fail, plus precomposed `é`. Restore it.

If any sabotage leaves the suite green, the corresponding test is vacuous — fix the test before continuing.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
npm run build
git add package.json package-lock.json src/utils/display-width.ts src/__tests__/display-width.test.ts
git add -f dist/index.js
git commit -m "Add grapheme-cluster display width measurement (#86)"
```

---

### Task 2: Route visibleLength through it

The behavior change lands here. Nothing else in this task — the point is to isolate the moment existing measurements could shift.

**Files:**
- Modify: `src/utils/terminal.ts:40-42`

**Interfaces:**
- Consumes: `displayWidth` from Task 1.
- Produces: `visibleLength(str: string): number` keeps its exact existing signature — now measuring columns rather than UTF-16 units. `flex.ts`, `renderer.ts`, `truncation.ts` and `shrink.ts` call it unchanged.

- [ ] **Step 1: Record the baseline**

```bash
npm test 2>&1 | tail -5
```

Write down the test count. Expected: all pass (661 tests at the time of writing).

- [ ] **Step 2: Change visibleLength**

In `src/utils/terminal.ts`, add the import at the top alongside the existing imports:

```ts
import { displayWidth } from "./display-width.js";
```

Replace the existing `visibleLength`:

```ts
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}
```

with:

```ts
/**
 * Terminal columns `str` occupies, ignoring ANSI colour codes.
 *
 * Measures COLUMNS, not characters and not UTF-16 code units. `String.length`
 * counts code units, so a CJK glyph — two columns wide — counted as one, and
 * every width decision built on this (shrink, truncate, compact-fit)
 * under-measured by half and overflowed the terminal. Issue #86.
 *
 * `stripAnsi` only removes SGR sequences; any other escape is still counted as
 * visible text. Reachable via the `custom-command` widget, tracked separately.
 */
export function visibleLength(str: string): number {
  return displayWidth(stripAnsi(str));
}
```

- [ ] **Step 3: Run the full suite and check the invariant**

Run: `npm test`

Expected: **exactly the same tests pass as in Step 1.** Pay particular attention to `src/__tests__/default-layout-width.test.ts`, which asserts the exact figures 88, 80 and 79.

Every glyph the default bar draws is either ASCII or Ambiguous, and both measure 1 under either implementation — so these figures must not move. **If any of them shifts, stop and report.** It means the Ambiguous policy is wrong. Do not update the expectation to match the new output.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
npm run build
git add src/utils/terminal.ts
git add -f dist/index.js
git commit -m "Measure visibleLength in terminal columns (#86)"
```

---

### Task 3: Fix truncateAnsi

Two defects here: a raw `.length` guard that lets the overflow through even after Task 2, and a per-UTF-16-unit walk that splits surrogate pairs.

**Files:**
- Modify: `src/render/truncation.ts` (whole file)
- Create: `src/__tests__/truncation.test.ts`

**Interfaces:**
- Consumes: `splitGraphemes`, `graphemeWidth` from Task 1; `visibleLength`, `stripAnsi` from `terminal.ts`.
- Produces: `truncateAnsi(str: string, maxWidth: number | undefined): string` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/truncation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { truncateAnsi } from "../render/truncation.js";
import { visibleLength } from "../utils/terminal.js";

const RESET = "\u001b[0m";

describe("truncateAnsi", () => {
  it("returns the string untouched when the width is unknown", () => {
    expect(truncateAnsi("日本語プロジェクト", undefined)).toBe("日本語プロジェクト");
  });

  it("returns the string untouched when it already fits", () => {
    expect(truncateAnsi("abc", 10)).toBe("abc");
    expect(truncateAnsi("日本語", 10)).toBe("日本語");
  });

  it("truncates a wide string that String.length says already fits", () => {
    // The regression this test exists for: 17 CJK glyphs are 34 columns but
    // String.length reports 17. The old `plain.length <= maxWidth` guard
    // returned this untouched at maxWidth 20, so the bar overflowed by 14.
    const name = "日本語プロジェクト名前テストの長い";
    const out = truncateAnsi(name, 20);
    expect(out).not.toBe(name);
    expect(visibleLength(out)).toBeLessThanOrEqual(20);
  });

  it("never exceeds maxWidth, across a sweep of widths and scripts", () => {
    const samples = [
      "abcdefghijklmnopqrstuvwxyz",
      "日本語プロジェクト名前テストの長い",
      "mixed 日本語 and ascii text here",
      "\u{1F468}‍\u{1F469}‍\u{1F467} family branch name",
      "\u001b[31mred\u001b[0m 日本語 \u001b[32mgreen\u001b[0m text",
      // Malformed escapes. These are the ONLY inputs that reach the text-run
      // branch while sitting on an ESC, which is exactly where the
      // `indexOf("\u001b", i + 1)` offset stops an empty run and an infinite
      // loop. Verified while writing this plan: well-formed SGR input never
      // reaches that branch, so without these two samples the guard is
      // completely untested and the Step 6 sabotage cannot fail.
      "ab\u001bcdefghij", // bare ESC, not followed by '['
      "ab\u001b[31cdefghij", // unterminated SGR, no terminating 'm'
    ];
    for (const sample of samples) {
      for (let width = 2; width <= 40; width++) {
        expect(visibleLength(truncateAnsi(sample, width))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("stops before a wide cluster that would straddle the boundary", () => {
    // Budget is maxWidth - 1 (one column reserved for the ellipsis). At
    // maxWidth 6 the budget is 5: two CJK glyphs fill 4, the third would
    // reach 6 and overflow, so it is dropped and the result is 5 columns —
    // one short of maxWidth. That is correct. Never widen this to 6.
    const out = truncateAnsi("日本語漢字", 6);
    expect(visibleLength(out)).toBe(5);
    expect(out).toContain("…");
  });

  it("never splits a grapheme cluster at the cut point", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const out = truncateAnsi(`ab${family}cd`, 5);
    // Budget is 4 (maxWidth 5, one column reserved for the ellipsis): "a" and
    // "b" take 1 each, the family cluster takes 2 and exactly fills it, then
    // "c" is dropped. So the cluster survives WHOLE.
    expect(out).toContain(family);
    // And in general: never a fragment of one. A UTF-16-unit walk leaves a
    // lone surrogate or an orphaned joiner at some cut point in this sweep.
    for (let width = 2; width <= 12; width++) {
      const cut = truncateAnsi(`ab${family}cd`, width);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false); // no lone high surrogate
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false); // no lone low surrogate
      expect(cut).not.toMatch(/‍…/); // no ZWJ orphaned against the ellipsis
    }
  });

  it("preserves ANSI escapes and appends a reset", () => {
    const out = truncateAnsi("\u001b[31mredredredred\u001b[0m", 6);
    expect(out).toContain("\u001b[31m");
    expect(out.endsWith(RESET)).toBe(true);
  });

  it("emits no content at a degenerate width", () => {
    // maxWidth 1 leaves a budget of 0, and the ellipsis alone would occupy
    // the only column; maxWidth 0 has nowhere to put anything at all.
    expect(truncateAnsi("abcdef", 1)).toBe(RESET);
    expect(truncateAnsi("abcdef", 0)).toBe(RESET);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/truncation.test.ts`

Expected: FAIL. Specifically `truncates a wide string that String.length says already fits` fails (the `plain.length` guard returns the input untouched), and `emits no content at a degenerate width` fails.

- [ ] **Step 3: Rewrite truncation.ts**

Replace the whole file with:

```ts
import { stripAnsi, visibleLength } from "../utils/terminal.js";
import { graphemeWidth, splitGraphemes } from "../utils/display-width.js";

const ELLIPSIS = "…";
const RESET = "\u001b[0m";

/**
 * `str` cut to at most `maxWidth` terminal columns, ending in an ellipsis.
 *
 * Walks grapheme clusters, not UTF-16 units: the previous implementation
 * incremented one column per code unit, which both under-counted wide glyphs
 * and could cut a surrogate pair in half. Issue #86.
 *
 * It also carried a second guard, `stripAnsi(str).length <= maxWidth`, that
 * defeated the whole fix on its own — 17 CJK glyphs are 34 columns but report
 * a `length` of 17, so a bar overflowing a 20-column budget was returned
 * untouched. That guard is deliberately gone; do not reintroduce it.
 */
export function truncateAnsi(str: string, maxWidth: number | undefined): string {
  // Unknown width: return the line untouched. Claude Code truncates on its own
  // end, so an over-long line degrades to its behaviour, whereas truncating to
  // a guessed width destroys output that would have fit.
  if (maxWidth === undefined) return str;
  if (visibleLength(str) <= maxWidth) return str;

  // One column is reserved for the ellipsis (`…` is East_Asian_Width Ambiguous,
  // which this codebase measures as 1). At maxWidth <= 1 there is no room for
  // content, and the ellipsis alone would occupy the whole budget or overflow
  // it — so emit nothing rather than break the contract this function exists
  // to enforce.
  const budget = maxWidth - 1;
  if (budget <= 0) return RESET;

  const result: string[] = [];
  let used = 0;
  let i = 0;

  while (i < str.length) {
    // SGR escapes are copied verbatim and cost no columns.
    if (str[i] === "\u001b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        result.push(str.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }

    // The run of text up to the next escape. Searching from `i + 1` matters:
    // a lone ESC that is not a valid SGR sequence reaches here, and searching
    // from `i` would find it again, yielding an empty run and spinning
    // forever. Included in the run instead, it costs one column — exactly what
    // the previous implementation charged it.
    //
    // Segmenting per run means a cluster split ACROSS an escape (`a`, ESC[31m,
    // U+0301) is not rejoined. chalk wraps whole segments, so this does not
    // arise in practice; it is stated rather than papered over.
    let runEnd = str.indexOf("\u001b", i + 1);
    if (runEnd === -1) runEnd = str.length;

    for (const cluster of splitGraphemes(str.slice(i, runEnd))) {
      const width = graphemeWidth(cluster);
      // Stop BEFORE a cluster that would straddle the budget. A wide cluster
      // at the boundary leaves the result one column short of maxWidth, which
      // is correct: never overflow.
      if (used + width > budget) {
        result.push(ELLIPSIS, RESET);
        return result.join("");
      }
      result.push(cluster);
      used += width;
    }

    i = runEnd;
  }

  // Unreachable while `visibleLength(str) > maxWidth` holds — kept so the
  // function still terminates correctly if that invariant is ever loosened.
  result.push(ELLIPSIS, RESET);
  return result.join("");
}
```

Note `stripAnsi` is no longer used in this file — remove it from the import if the typecheck flags it as unused.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/truncation.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, and the exact figures in `default-layout-width.test.ts` (88, 80, 79) unchanged. Stop and report if any shifted.

- [ ] **Step 6: Sabotage-check**

1. Re-add `const plain = stripAnsi(str); if (plain.length <= maxWidth) return str;` after the `visibleLength` guard. Expected: `truncates a wide string that String.length says already fits` goes red. Remove it again.
2. Change `if (used + width > budget)` to `>=`. Expected: the straddle test goes red (result becomes 3 or 4 columns, not 5). Restore.
3. Change `str.indexOf("\u001b", i + 1)` back to `str.indexOf("\u001b", i)`. Expected: `never exceeds maxWidth` HANGS and vitest kills it on the test timeout. Restore.

   Be precise about why, because the obvious guess is wrong: a well-formed SGR sequence is consumed by the branch above and never reaches this line, so the coloured sample does **not** hang. Only a malformed escape — the bare `\u001b` and the unterminated `\u001b[31c` added to `samples` in Step 1 — lands on the text-run branch while sitting on an ESC, where searching from `i` finds that same ESC, yields an empty run, and leaves `i` unchanged. If the sabotage does not hang, those two samples are missing from the sweep and the guard is untested.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
npm run build
git add src/render/truncation.ts src/__tests__/truncation.test.ts
git add -f dist/index.js
git commit -m "Truncate by grapheme cluster and column width (#86)"
```

---

### Task 4: Trim by cluster in shrink.ts

**Files:**
- Modify: `src/render/shrink.ts` (the `trimTo` function and two comment blocks)
- Modify: `src/__tests__/shrink.test.ts` (append one test)

**Interfaces:**
- Consumes: `splitGraphemes` from Task 1.
- Produces: no signature changes. `shrinkOutputs(outputs, overflow)` and `MIN_SHRUNK_TEXT` keep their exports.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("shrinkOutputs", ...)` block in `src/__tests__/shrink.test.ts`:

```ts
  it("never leaves a dangling ZWJ or a split surrogate when trimming", () => {
    // A branch name whose trailing glyph is a ZWJ family emoji. Code-point
    // slicing removes one piece at a time and can stop mid-sequence, leaving
    // a joiner with nothing to join or half a surrogate pair.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const outputs = [shrinkable(`feature/long-branch-name-${family}`)];

    for (let overflow = 1; overflow <= 20; overflow++) {
      const text = shrinkOutputs(outputs, overflow)[0]!.text;
      expect(text.endsWith("‍…")).toBe(false); // no dangling joiner
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/shrink.test.ts`
Expected: FAIL on the dangling-joiner assertion at some overflow value, because `Array.from` slices by code point.

- [ ] **Step 3: Switch trimTo to cluster slicing**

In `src/render/shrink.ts`, add to the imports:

```ts
import { splitGraphemes } from "../utils/display-width.js";
```

Replace the `trimTo` doc block and body. The old doc block reads:

```
 * Slices by code point: `String.prototype.slice` would cut a surrogate pair in
 * half, so a branch name containing an emoji would render as a broken glyph.
 *
 * When text contains multi-column characters (astral characters like emoji),
 * removing one code point removes multiple columns. ...
```

Replace it with:

```ts
/**
 * `text` reduced to at most `width` visible columns, ending in an ellipsis.
 *
 * Slices by grapheme cluster. `String.prototype.slice` would cut a surrogate
 * pair in half, and code-point slicing — what this used to do — would strip a
 * combining mark off its base or leave a ZWJ with nothing to join, so a branch
 * name containing an emoji rendered as a broken glyph.
 *
 * A single cluster can occupy two terminal columns (CJK, emoji), so removing
 * one cluster can remove two columns. If removing one more would cross below
 * MIN_SHRUNK_TEXT, we stop and return a result slightly wider than requested
 * rather than violating the floor — the caller's truncation is the backstop.
 * This can overshoot the requested overflow slightly (removing 5 columns when
 * 4 were asked), which is acceptable.
 */
function trimTo(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let clusters = splitGraphemes(text);
  // Trim by cluster until the result fits the target AND never drops below the floor.
  while (clusters.length > 0) {
    const current = visibleLength(clusters.join("") + ELLIPSIS);
    // Stop if we've reached the target.
    if (current <= width) break;
    // Peek ahead: what if we removed one more?
    const nextClusters = clusters.slice(0, -1);
    const next = visibleLength(nextClusters.join("") + ELLIPSIS);
    // Stop if removing one more would drop below the floor.
    if (next < MIN_SHRUNK_TEXT) break;
    // Safe to proceed.
    clusters = nextClusters;
  }
  return clusters.join("") + ELLIPSIS;
}
```

- [ ] **Step 4: Update the `stuck` comment in shrinkOutputs**

Inside `shrinkOutputs`, the comment above `const stuck = new Set<number>();` currently says "a segment made of multi-column (astral) characters". Replace that sentence so it describes columns rather than the old surrogate-pair reasoning:

```ts
  // Indices `trimTo` cannot shorten any further without breaching the floor.
  // Without this, a segment made of two-column clusters (CJK, emoji) can sit
  // ABOVE the floor (say, width 9) purely as `trimTo`'s peek-ahead overshoot,
  // so the `width > MIN_SHRUNK_TEXT` eligibility check below keeps re-selecting
  // it — and re-trimming it to the exact same text forever, since the very
  // same peek-ahead refuses to take it down to 7. Comparing `trimTo`'s output
  // width against the input width (not against MIN_SHRUNK_TEXT) is what
  // detects that zero progress was made, regardless of why.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/shrink.test.ts`
Expected: PASS, including the pre-existing shrink tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass; the 88/80/79 figures unchanged.

- [ ] **Step 7: Sabotage-check**

Change `splitGraphemes(text)` back to `Array.from(text)`. Expected: the new dangling-joiner test goes red. Restore.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npm run build
git add src/render/shrink.ts src/__tests__/shrink.test.ts
git add -f dist/index.js
git commit -m "Trim shrinkable segments by grapheme cluster (#86)"
```

---

### Task 5: The issue's acceptance criterion, the perf measurement, and the follow-up issue

**Files:**
- Modify: `src/__tests__/default-layout-width.test.ts` (append one describe block)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing new.

- [ ] **Step 1: Write the acceptance test**

Append to `src/__tests__/default-layout-width.test.ts`, after the existing `describe` blocks:

```ts
describe("wide characters (issue #86)", () => {
  // The issue's exact reproduction: a project directory named with 17 CJK
  // glyphs. String.length reports 17, the terminal draws 34 columns, so the
  // bar overflowed a 45-column terminal by 7 without ever registering that
  // it had. `compact.mode: "never"` keeps the full two-line layout rather
  // than collapsing to the single compacted line at this width.
  const CJK_PROJECT = "日本語プロジェクト名前テストの長い";
  const NARROW_WIDTH = 45;

  function cjkContext() {
    const fx = midFixture as unknown as RealPayloadFixture;
    const base = contextFromFixture(fx, "/home/testuser");
    return {
      ...base,
      stdin: {
        ...base.stdin,
        workspace: {
          ...base.stdin.workspace,
          project_dir: `/home/testuser/projects/${CJK_PROJECT}`,
        },
      },
    } as typeof base;
  }

  it("measures the CJK project name at two columns per glyph", () => {
    expect(CJK_PROJECT.length).toBe(17);
    expect(visibleLength(CJK_PROJECT)).toBe(34);
  });

  it("keeps every line within the terminal width", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      compact: { ...DEFAULT_SETTINGS.compact, mode: "never" as const },
    };
    const output = renderStatusline(
      { ...cjkContext(), terminalWidth: NARROW_WIDTH },
      settings,
    );

    const lines = stripAnsi(output).split("\n");
    // Guard against a vacuous pass: the project segment must actually be
    // present (possibly truncated), or this asserts nothing about CJK at all.
    expect(lines.some((line) => line.includes(CJK_PROJECT.slice(0, 2)))).toBe(true);

    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(NARROW_WIDTH);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx vitest run src/__tests__/default-layout-width.test.ts`
Expected: PASS.

- [ ] **Step 3: Prove it would have failed before the fix**

The spec requires this test to fail against the pre-fix implementation. Verify by reverting the two load-bearing changes together:

1. In `src/utils/terminal.ts`, change `visibleLength` back to `return stripAnsi(str).length;`.
2. In `src/render/truncation.ts`, re-add `const plain = stripAnsi(str); if (plain.length <= maxWidth) return str;` after the `visibleLength` guard.

Run: `npx vitest run src/__tests__/default-layout-width.test.ts`
Expected: BOTH new tests fail — the measurement one reports 17 instead of 34, and the width one reports a line exceeding 45.

Restore both changes and re-run to confirm green. **Do not commit the reverted state.**

- [ ] **Step 4: Measure the render path**

The spec deferred the fast-path decision to measurement. Use this repo's established method: the merge-base bundle as the before-binary, statusline cache cleared between runs, timed to process exit.

```bash
git show main:dist/index.js > /tmp/before-index.js
rm -f ~/.cache/gccusage/statusline-cache.json
# capture a real payload once
echo '<paste a real stdin payload here, or reuse one from src/__tests__/fixtures/real-payloads/>' > /tmp/payload.json

for i in 1 2 3; do rm -f ~/.cache/gccusage/statusline-cache.json; /usr/bin/time -p node /tmp/before-index.js < /tmp/payload.json > /dev/null; done
for i in 1 2 3; do rm -f ~/.cache/gccusage/statusline-cache.json; /usr/bin/time -p node dist/index.js < /tmp/payload.json > /dev/null; done
```

Record both figures in the PR description.

Decision rule, stated up front so the result cannot be rationalised after the fact: **if the after-figure is within 10ms of the before-figure, add no fast path.** The spec's benchmark put the segmenter at ~4µs per call against a ~60ms budget, and an ASCII fast path would miss the default bar anyway because `▶` is not ASCII. Only if the regression exceeds 10ms does a fast path get designed — and it would need to be a non-ASCII-tolerant one.

- [ ] **Step 5: File the out-of-scope follow-up**

```bash
gh issue create \
  --title "stripAnsi matches only SGR, so non-SGR escapes are counted as visible text" \
  --label bug \
  --body "\`stripAnsi\` in \`src/utils/terminal.ts\` matches \`/\x1b\[[0-9;]*m/g\` — SGR sequences only. Any other escape (OSC-8 hyperlinks, cursor movement, mode switches) is counted as visible text by \`visibleLength\`, so the bar over-measures and truncates prematurely.

Reachable in practice: the \`custom-command\` widget runs an arbitrary shell command and puts its output in the bar, so whatever escapes that command emits flow straight into the width math.

Split out of #86, where it was deliberately left out of scope — it is a distinct defect with a distinct fix. See \`docs/superpowers/specs/2026-08-02-display-width-design.md\`, 'Out of scope'."
```

- [ ] **Step 6: Full verification**

```bash
npm run typecheck
npm run typecheck:scripts
npm test
npm run build
git diff --stat dist/index.js   # must be empty — the bundle was staged in Task 4
```

Expected: typechecks pass, full suite passes, and `dist/index.js` shows no drift.

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/default-layout-width.test.ts
git commit -m "Pin the CJK overflow case from issue #86"
```

- [ ] **Step 8: Update AUDIT.md**

Add a row to the remediation log for COR-003 / #86, following the format of the existing rows: what the root cause turned out to be, what was deliberately not done (the `stripAnsi` non-SGR gap, split to its own issue), and the measured before/after render figures from Step 4.

`AUDIT.md` is **deliberately untracked** — edit it locally and never stage it.

---

## Self-Review

**Spec coverage.** `get-east-asian-width` dependency → Task 1 Step 1. Ambiguous-as-narrow with the explicit option → Task 1 Step 4 + the policy tests + sabotage 3. `Intl.Segmenter` clusters → Task 1. VS16 and Regional Indicator rules → Task 1, both sabotage-checked. Three exported functions including `graphemeWidth` → Task 1. `visibleLength` delegation → Task 2. `truncateAnsi` including the deleted `plain.length` guard, the ANSI-run tokenizer, the straddle behaviour and the degenerate `maxWidth` → Task 3. `trimTo` cluster slicing plus both stale comment blocks → Task 4. The regression invariant (88/80/79 unchanged) → Global Constraints, restated in Tasks 2, 3 and 4. The issue's acceptance criterion and its must-fail-before proof → Task 5 Steps 1–3. Deferred fast-path measurement with a decision rule → Task 5 Step 4. The `stripAnsi` out-of-scope follow-up → Task 5 Step 5. Bundle rebuild → every commit step, and Global Constraints.

**Placeholder scan.** One intentional gap: Task 5 Step 4 needs a real stdin payload, which depends on the executing machine — the step names `src/__tests__/fixtures/real-payloads/` as the source rather than leaving it undefined.

**Prototype verification.** The truncation algorithm in Task 3 was run as a standalone prototype before this plan was written, so every figure it asserts is measured rather than reasoned: the straddle case at `maxWidth` 6 yields 5 columns (`日本…`), the 17-glyph CJK name measures 34 against a `String.length` of 17, the degenerate widths return bare reset, the family cluster survives whole at width 5, and a 5-sample x 39-width sweep produced zero overflows and zero fragments. The infinite-loop sabotage was verified separately, and **contradicted the first draft of this plan**: well-formed SGR input never reaches the branch the `i + 1` offset protects, so only a malformed escape can trigger the loop. Two such samples were added to the sweep; without them that sabotage silently passes and the guard is untested.

**Type consistency.** `splitGraphemes`, `graphemeWidth` and `displayWidth` are spelled identically in Tasks 1, 3 and 4. `visibleLength` and `truncateAnsi` keep their existing signatures throughout. `MIN_SHRUNK_TEXT` and `ELLIPSIS` are referenced in Task 4 exactly as `shrink.ts` already defines them.
