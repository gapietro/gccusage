import { describe, it, expect } from "vitest";
import { THEMES } from "../render/themes.js";
import { colorDistance } from "../render/color-compare.js";
import { MIN_SEPARATOR_DELTA } from "../render/powerline.js";
import { isValidColor } from "../render/colors.js";

// The MIN_SEPARATOR_DELTA floor (src/render/powerline.ts) applies to ANY pair
// of adjacent resolved backgrounds, not just the widget-supplied `bg`s in
// DEFAULT_SETTINGS. layoutPowerline cycles through a theme's segments with
// `i % theme.segments.length`, so a custom layout whose widgets omit `bg`
// (the shape the README's "Change theme" example implies — DEFAULT_SETTINGS
// itself sets a `bg` on every widget, so themes are inert there) walks the
// theme's own background ramp, including the wrap from the last segment back
// to index 0 for a 5th+ segment.
//
// A below-threshold boundary here is NOT a bug: it means that theme's ramp
// is subtle enough that the wide `▶` (painted in the previous segment's bg)
// would not read against the next one, so layoutPowerline falls back to the
// thin `│` (painted in the previous segment's fg) — which is what actually
// keeps the seam visible. `minimal` and `forest` in particular were already
// carrying wide-separator boundaries as low as ΔE 2.43 before issue #40; the
// thin fallback is a functional improvement for them, not a regression to
// fix by re-shading the palette (out of scope for this branch — see the
// issue #40 final-review spec addendum).
//
// These counts were measured during final review (2026-07-30) against this
// implementation and are pinned here so that any future re-shading of a
// theme ramp, or any change to MIN_SEPARATOR_DELTA, fails loudly and forces
// a deliberate decision rather than silently changing which themes render
// wide vs. thin separators.
const EXPECTED_BELOW_THRESHOLD: Record<string, number> = {
  default: 1,
  ocean: 2,
  forest: 3,
  sunset: 0,
  minimal: 3,
};

describe("theme background ramps vs MIN_SEPARATOR_DELTA", () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    it(`${name}: below-threshold boundary count matches the measured baseline`, () => {
      const segs = theme.segments;
      const n = segs.length;
      let belowCount = 0;

      for (let i = 0; i < n; i++) {
        const prev = segs[i]!;
        const next = segs[(i + 1) % n]!;
        const distance = colorDistance(prev.bg, next.bg);

        if (distance < MIN_SEPARATOR_DELTA) {
          belowCount++;

          // The thin separator is drawn in the *previous* segment's fg
          // against the incoming bg (fg = prev.fg, bg = next.bg — see
          // layoutPowerline). For the thin fallback to actually be legible
          // where the wide one is not, that pairing must clear the same
          // floor.
          const thinDistance = colorDistance(prev.fg, next.bg);
          expect(
            thinDistance,
            `${name} boundary ${i}->${(i + 1) % n}: thin separator fg ` +
              `${prev.fg} vs incoming bg ${next.bg} is only ΔE ` +
              `${thinDistance.toFixed(2)}, below the floor — the fallback ` +
              `would be illegible too`,
          ).toBeGreaterThanOrEqual(MIN_SEPARATOR_DELTA);
        }
      }

      expect(
        belowCount,
        `${name}: expected ${EXPECTED_BELOW_THRESHOLD[name]} boundaries ` +
          `below ΔE ${MIN_SEPARATOR_DELTA}, found ${belowCount}. If this ` +
          `theme's colors or MIN_SEPARATOR_DELTA changed intentionally, ` +
          `update EXPECTED_BELOW_THRESHOLD deliberately — do not just bump ` +
          `the number to make this pass.`,
      ).toBe(EXPECTED_BELOW_THRESHOLD[name]);
    });
  }
});

describe("theme colors", () => {
  it("uses only colors a user could write in their own config", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const [index, segment] of theme.segments.entries()) {
        expect(isValidColor(segment.fg), `${name}.segments.${index}.fg = ${segment.fg}`).toBe(true);
        expect(isValidColor(segment.bg), `${name}.segments.${index}.bg = ${segment.bg}`).toBe(true);
      }
    }
  });
});
