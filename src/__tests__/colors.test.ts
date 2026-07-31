import { describe, it, expect } from "vitest";
import { isValidColor, NAMED_COLORS } from "../render/colors.js";

describe("isValidColor", () => {
  // Table-driven over the map itself: adding a name to NAMED_COLORS without
  // it validating fails here rather than at render time.
  it.each(Object.keys(NAMED_COLORS))("accepts the named color %s", (name) => {
    expect(isValidColor(name)).toBe(true);
  });

  it.each(["RED", "Red", "  red  ", "\tblue\n"])(
    "normalizes %j the way resolveColor does",
    (input) => {
      expect(isValidColor(input)).toBe(true);
    },
  );

  it.each(["#abc", "#fff", "#AABBCC", "#000000", "#1a5fb4"])(
    "accepts the hex color %s",
    (hex) => {
      expect(isValidColor(hex)).toBe(true);
    },
  );

  // Issue #42: these are the ansi256 codes chalk's unanchored regex
  // misparses into unrelated colors ("196" paints #119966).
  it.each(["196", "255", "100", "21", "9"])(
    "rejects the ansi256 code %s",
    (code) => {
      expect(isValidColor(code)).toBe(false);
    },
  );

  it.each(["#12345", "#abcd", "#gg0000", "#", "#1234567", "##fff"])(
    "rejects the near-miss hex %s",
    (value) => {
      expect(isValidColor(value)).toBe(false);
    },
  );

  it.each(["abc", "aabbcc"])(
    "rejects hex without a leading #: %s",
    (value) => {
      expect(isValidColor(value)).toBe(false);
    },
  );

  it.each(["grey1", "banana", "", "   "])(
    "rejects the unknown name %j",
    (value) => {
      expect(isValidColor(value)).toBe(false);
    },
  );

  // resolveColor uses Object.hasOwn rather than a truthiness check for this
  // reason; isValidColor must agree or a prototype key would validate and
  // then resolve to a function.
  it.each(["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"])(
    "rejects the Object.prototype key %s",
    (key) => {
      expect(isValidColor(key)).toBe(false);
    },
  );
});
