import { describe, it, expect } from "vitest";
import {
  AUTOCOMPACT_RESERVE,
  AMBER_TOKENS,
  RED_TOKENS,
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
