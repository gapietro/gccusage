import { describe, it, expect } from "vitest";
import {
  AUTOCOMPACT_RESERVE,
  AMBER_TOKENS,
  RED_TOKENS,
  alertLevel,
  compactThresholdTokens,
  tokensUntilCompact,
} from "../utils/autocompact.js";

describe("compactThresholdTokens", () => {
  it("reserves a fixed 33k below the window", () => {
    expect(AUTOCOMPACT_RESERVE).toBe(33_000);
    expect(compactThresholdTokens(200_000)).toBe(167_000);
    expect(compactThresholdTokens(1_000_000)).toBe(967_000);
  });

  // The old constant was a fraction (1 - 0.165). It happened to be exact at
  // 200k and 132k tokens early at 1M, which is why it survived review.
  it("is not a fixed fraction of the window", () => {
    expect(compactThresholdTokens(200_000)! / 200_000).toBeCloseTo(0.835, 10);
    expect(compactThresholdTokens(1_000_000)! / 1_000_000).toBeCloseTo(0.967, 10);
  });

  it("returns null when the window is too small to model", () => {
    expect(compactThresholdTokens(33_000)).toBeNull();
    expect(compactThresholdTokens(10_000)).toBeNull();
    expect(compactThresholdTokens(0)).toBeNull();
  });

  it("returns null for a non-finite window", () => {
    expect(compactThresholdTokens(Number.NaN)).toBeNull();
    expect(compactThresholdTokens(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("tokensUntilCompact", () => {
  it("counts down to the threshold", () => {
    expect(tokensUntilCompact(0, 200_000)).toBe(167_000);
    expect(tokensUntilCompact(50_000, 200_000)).toBe(117_000);
    expect(tokensUntilCompact(70_000, 1_000_000)).toBe(897_000);
  });

  it("lands exactly on the band boundaries", () => {
    expect(AMBER_TOKENS).toBe(20_000);
    expect(RED_TOKENS).toBe(5_000);
    expect(tokensUntilCompact(147_000, 200_000)).toBe(AMBER_TOKENS);
    expect(tokensUntilCompact(162_000, 200_000)).toBe(RED_TOKENS);
    expect(tokensUntilCompact(947_000, 1_000_000)).toBe(AMBER_TOKENS);
    expect(tokensUntilCompact(962_000, 1_000_000)).toBe(RED_TOKENS);
  });

  it("clamps to zero past the threshold", () => {
    expect(tokensUntilCompact(167_000, 200_000)).toBe(0);
    expect(tokensUntilCompact(190_000, 200_000)).toBe(0);
  });

  it("returns null when the window is too small to model", () => {
    expect(tokensUntilCompact(1_000, 20_000)).toBeNull();
  });
});

describe("alertLevel (#46)", () => {
  it("uses the flat bands when the count is exact", () => {
    expect(alertLevel(RED_TOKENS, 1)).toBe("red");
    expect(alertLevel(RED_TOKENS + 1, 1)).toBe("amber");
    expect(alertLevel(AMBER_TOKENS, 1)).toBe("amber");
    expect(alertLevel(AMBER_TOKENS + 1, 1)).toBeNull();
  });

  it("widens a band that is narrower than its own input's step", () => {
    // One percentage point of a 1M window is 10k tokens — twice the 5k red
    // band, so a percentage-derived countdown could never land inside it.
    expect(alertLevel(7_000, 10_000)).toBe("red");
    expect(alertLevel(7_000, 1)).toBe("amber");
  });

  it("keeps amber above the widened red band rather than letting red swallow it", () => {
    // Fixing red by widening it alone would push red up to amber's edge and
    // make AMBER the unreachable one — the same defect mirrored.
    expect(alertLevel(17_000, 10_000)).toBe("amber");
    expect(alertLevel(30_000, 20_000)).toBe("amber");
    expect(alertLevel(20_000, 20_000)).toBe("red");
  });

  // The property the issue is really about: it is not enough that the
  // arithmetic is right at hand-picked inputs — every band must be reachable
  // by inputs that can actually occur. Real payloads carry whole-number
  // percentages, so those are the only inputs swept here.
  it.each([200_000, 1_000_000, 2_000_000])(
    "reaches both bands from whole-number percentages at a %i window",
    (windowSize) => {
      const step = windowSize / 100;
      const levels = new Set<string | null>();
      for (let pct = 0; pct <= 100; pct++) {
        const remaining = tokensUntilCompact((pct / 100) * windowSize, windowSize);
        if (remaining !== null && remaining > 0) levels.add(alertLevel(remaining, step));
      }
      expect(levels.has("red"), `red unreachable at ${windowSize}`).toBe(true);
      expect(levels.has("amber"), `amber unreachable at ${windowSize}`).toBe(true);
    },
  );

  it("leaves red unreachable at 1M if the step is ignored", () => {
    // Guards the guard: this is the pre-fix behaviour, so if alertLevel ever
    // stops consulting the step the sweep above must genuinely start failing.
    const levels = new Set<string | null>();
    for (let pct = 0; pct <= 100; pct++) {
      const remaining = tokensUntilCompact((pct / 100) * 1_000_000, 1_000_000);
      if (remaining !== null && remaining > 0) levels.add(alertLevel(remaining, 1));
    }
    expect(levels.has("red")).toBe(false);
    expect(levels.has("amber")).toBe(true);
  });
});
