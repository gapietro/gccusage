import { describe, it, expect } from "vitest";
import { percentile, summarize, costEquivalent, COST_WEIGHTS } from "../lib/stats.ts";

describe("percentile", () => {
  it("returns NaN for an empty array", () => {
    expect(percentile([], 0.5)).toBeNaN();
  });

  it("returns the only value for a single-element array", () => {
    expect(percentile([42], 0.9)).toBe(42);
  });

  it("returns the median of an odd-length array", () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
  });

  it("interpolates between neighbours", () => {
    // p75 over [0,1,2,3]: index 0.75*3 = 2.25 -> 2 + (3-2)*0.25
    expect(percentile([0, 1, 2, 3], 0.75)).toBeCloseTo(2.25, 10);
  });

  it("does not mutate the caller's array", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it("returns the extremes at p=0 and p=1", () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });
});

describe("summarize", () => {
  it("reports n, min, max and mean", () => {
    const s = summarize([1, 2, 3, 4]);
    expect(s.n).toBe(4);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.mean).toBe(2.5);
  });

  it("reports a zero-length summary without throwing", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.p50).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});

describe("costEquivalent", () => {
  it("weights a pure fresh-input turn at 1x per token", () => {
    expect(
      costEquivalent({
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(100);
  });

  it("weights output at 5x and cache reads at 0.1x", () => {
    expect(
      costEquivalent({
        inputTokens: 0,
        outputTokens: 10,
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
      }),
    ).toBeCloseTo(50 + 100, 10);
  });

  it("weights cache creation at 1.25x", () => {
    expect(
      costEquivalent({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 400,
      }),
    ).toBe(500);
  });
});

describe("COST_WEIGHTS", () => {
  it("keeps the documented ratios", () => {
    expect(COST_WEIGHTS).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
  });
});
