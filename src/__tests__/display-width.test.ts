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
