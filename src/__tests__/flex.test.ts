import { describe, it, expect } from "vitest";
import { applyFlex } from "../render/flex.js";

/**
 * `applyFlex` is the last thing to touch a line before it is written, and until
 * now only its `left` branch was ever exercised (54% of statements): the
 * default layout ships `flex: "left"`, so every other mode reached production
 * unmeasured. These are direct unit tests because the modes are only reachable
 * through a non-default config, which no fixture uses.
 */
describe("applyFlex", () => {
  describe("cases where there is nothing to justify against", () => {
    it("returns the joined content unchanged when the width is unknown", () => {
      // Not `left`-aligned-with-padding: padding to an unknown width is
      // impossible, so the mode is ignored entirely.
      expect(applyFlex(["ab", "cd"], undefined, "right")).toBe("abcd");
      expect(applyFlex(["ab", "cd"], undefined, "center")).toBe("abcd");
      expect(applyFlex(["ab", "cd"], undefined, "space-between")).toBe("abcd");
    });

    it("returns the content unpadded when it already fills the width", () => {
      expect(applyFlex(["abcd"], 4, "right")).toBe("abcd");
    });

    it("returns the content untouched when it overflows the width", () => {
      // Deliberately not truncated here — that is truncateAnsi's job, and
      // doing it in two places would truncate twice.
      expect(applyFlex(["abcdef"], 4, "center")).toBe("abcdef");
    });
  });

  describe("right", () => {
    it("puts the whole padding before the content", () => {
      expect(applyFlex(["ab"], 6, "right")).toBe("    ab");
    });
  });

  describe("center", () => {
    it("splits an even padding evenly", () => {
      expect(applyFlex(["ab"], 6, "center")).toBe("  ab  ");
    });

    it("gives an odd padding's extra column to the right", () => {
      // left = floor(5/2) = 2, right = 3. Fixed so the total width is exact:
      // rounding both sides up would overflow the terminal by a column.
      expect(applyFlex(["ab"], 7, "center")).toBe("  ab   ");
    });
  });

  describe("space-between", () => {
    it("pads to the right when there is only one segment", () => {
      // No gaps to distribute into, so it degrades to `left` rather than
      // dividing by zero.
      expect(applyFlex(["ab"], 6, "space-between")).toBe("ab    ");
    });

    it("pads to the right when there are no segments at all", () => {
      expect(applyFlex([], 4, "space-between")).toBe("    ");
    });

    it("distributes the padding into the gaps, never after the last segment", () => {
      // 3 segments, 2 gaps, padding 4 -> 2 columns per gap.
      expect(applyFlex(["a", "b", "c"], 7, "space-between")).toBe("a  b  c");
    });

    it("gives an indivisible remainder to the leftmost gaps", () => {
      // 3 segments, 2 gaps, padding 5 -> 3 then 2, not 2 then 2 with a
      // column dropped on the floor.
      expect(applyFlex(["a", "b", "c"], 8, "space-between")).toBe("a   b  c");
    });
  });

  describe("left", () => {
    it("puts the whole padding after the content", () => {
      expect(applyFlex(["ab"], 6, "left")).toBe("ab    ");
    });

    it("is the fallback for a mode outside the union", () => {
      // Reachable in practice: `flex` arrives from user JSON via a cast in
      // renderer.ts, so an unknown string is a real input, not a type error.
      expect(applyFlex(["ab"], 6, "sideways" as never)).toBe("ab    ");
    });
  });

  describe("width is measured in terminal columns, not characters", () => {
    it("ignores ANSI colour codes when computing the padding", () => {
      const coloured = "[31mab[39m";

      expect(applyFlex([coloured], 6, "right")).toBe("    " + coloured);
    });

    it("counts a wide glyph as the two columns it occupies", () => {
      // "漢" is one JS character but two columns, so the padding is 4, not 5.
      expect(applyFlex(["漢"], 6, "right")).toBe("    漢");
    });
  });
});
