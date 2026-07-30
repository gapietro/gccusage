import { describe, it, expect } from "vitest";
import { colorDistance, normalizeColor } from "../render/color-compare.js";

describe("normalizeColor", () => {
  it("lowercases and passes through valid 6-digit hex", () => {
    expect(normalizeColor("#AABBCC")).toBe("#aabbcc");
  });

  it("expands 3-digit hex", () => {
    expect(normalizeColor("#abc")).toBe("#aabbcc");
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
  });

  it("collapses non-hex values to the black chalk paints them as", () => {
    expect(normalizeColor("red")).toBe("#000000");
    expect(normalizeColor("blue")).toBe("#000000");
    expect(normalizeColor("")).toBe("#000000");
  });

  // Ground truth measured directly against this project's chalk@5.6.2 at
  // level 3 (see the fix report for the measurement script): the bg SGR
  // sequence chalk.bgHex(input) actually emits, decoded back to hex. These
  // assert against those measured values, not a re-derivation of the regex.
  it("matches chalk's own hexToRgb parsing exactly (measured, not re-derived)", () => {
    expect(normalizeColor("#abcd")).toBe("#aabbcc"); // 48;2;170;187;204
    expect(normalizeColor("#aabbcc")).toBe("#aabbcc"); // 48;2;170;187;204 — identical paint
    expect(normalizeColor("#12345")).toBe("#112233"); // 48;2;17;34;51
    expect(normalizeColor("#112233")).toBe("#112233"); // 48;2;17;34;51 — identical paint
    expect(normalizeColor("#abc")).toBe("#aabbcc"); // 48;2;170;187;204
    expect(normalizeColor("#gggggg")).toBe("#000000"); // 48;2;0;0;0 — no hex run
    expect(normalizeColor("#")).toBe("#000000"); // 48;2;0;0;0
    expect(normalizeColor("")).toBe("#000000"); // 48;2;0;0;0
  });
});

describe("colorDistance", () => {
  // Expected values come from `culori@4.0.2`'s differenceCiede2000() (see the
  // plan's Task 1 Step 2), NOT from this implementation. CIEDE2000's
  // hue-average and rotation terms are easy to get subtly wrong in ways that
  // still produce plausible numbers, so self-derived expectations would lock
  // in a bug. Values to 4 decimal places, computed via:
  //   culori.differenceCiede2000()(a, b)
  const REFERENCE: Array<[string, string, number]> = [
    // The four issue #40 design-spec pairs (MIN_SEPARATOR_DELTA = 8 depends
    // on 6.5435 sitting below it and 9.1382 above it).
    ["#a67c00", "#b8860b", 4.6128],
    ["#c01c28", "#a01822", 6.5435],
    ["#26a269", "#2ec27e", 9.1382],
    ["#613583", "#7d4fa8", 9.6281],

    // Greys (chroma 0 on one or both sides — undefined-hue branch).
    ["#000000", "#ffffff", 100.0],
    ["#808080", "#ffffff", 33.239],

    // One-sided chroma-zero: a grey beside a *chromatic* color, as opposed to
    // the two rows above which are grey-vs-grey (chroma 0 on BOTH sides, so
    // hBarP = h1p + h2p and dCp/dHp are all 0 there — those rows exercise the
    // lightness term only). These pin the undefined-hue branch somewhere its
    // value actually feeds dCp/dHp/hBarP. Live path: burn-rate is #555555, a
    // pure grey, adjacent to compact-countdown in the shipped default bar.
    // Verified against culori by a reviewer; this implementation already
    // reproduces them.
    ["#808080", "#0d7377", 22.3895],
    ["#000000", "#c01c28", 40.0335],

    // Red/magenta pairs whose hues straddle the 0/360 boundary (hue ~6-9°
    // vs hue ~358-359°, per culori's lch65), which is what exposes the
    // hue-average wraparound bug specifically.
    ["#c92462", "#b90363", 5.8303],
    ["#d02660", "#b40662", 8.7783],

    // High-chroma pairs spanning distant hues.
    ["#7d4fa8", "#0d7377", 32.2026],
    ["#0d7377", "#1a5fb4", 25.6923],
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
