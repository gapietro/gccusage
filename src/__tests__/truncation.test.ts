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
