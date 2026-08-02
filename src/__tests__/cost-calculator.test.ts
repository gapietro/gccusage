import { describe, it, expect } from "vitest";
import {
  calculateCost,
  calculateCostByModel,
  calculateBurnRate,
  findPricing,
} from "../data/cost-calculator.js";
import type { TokenMetrics } from "../types/token-metrics.js";
import type { PricingTable, ModelPricing } from "../types/pricing.js";

describe("calculateCost", () => {
  const pricing: ModelPricing = {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
  };

  it("calculates cost correctly", () => {
    const metrics: TokenMetrics = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 100,
    };

    const cost = calculateCost(metrics, pricing);
    const expected =
      1000 * (3 / 1_000_000) +
      500 * (15 / 1_000_000) +
      200 * (3.75 / 1_000_000) +
      100 * (0.3 / 1_000_000);
    expect(cost).toBeCloseTo(expected, 10);
  });
});

describe("findPricing", () => {
  const table: PricingTable = {
    "claude-sonnet-4-20250514": {
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
      cacheCreationCostPerToken: 3.75 / 1_000_000,
      cacheReadCostPerToken: 0.3 / 1_000_000,
    },
  };

  it("finds exact match", () => {
    expect(findPricing("claude-sonnet-4-20250514", table)).toBeTruthy();
  });

  it("returns null for unknown model", () => {
    expect(findPricing("gpt-4", table)).toBeNull();
  });
});

describe("calculateCostByModel", () => {
  it("calculates costs for all models", () => {
    const byModel = new Map<string, TokenMetrics>();
    byModel.set("claude-sonnet-4-20250514", {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    const pricing: PricingTable = {
      "claude-sonnet-4-20250514": {
        inputCostPerToken: 3 / 1_000_000,
        outputCostPerToken: 15 / 1_000_000,
        cacheCreationCostPerToken: 3.75 / 1_000_000,
        cacheReadCostPerToken: 0.3 / 1_000_000,
      },
    };

    const result = calculateCostByModel(byModel, pricing);
    expect(result.costs.size).toBe(1);
    expect(result.costs.get("claude-sonnet-4-20250514")).toBeGreaterThan(0);
    expect(result.unpriced).toEqual([]);
  });

  // A model with no price used to be dropped in silence, so its tokens
  // contributed 0 to a sum that still rendered as a confident dollar figure
  // (#82). The skip is now reported so the caller can mark the total.
  it("reports a model it could not price", () => {
    const byModel = new Map<string, TokenMetrics>();
    byModel.set("claude-brand-new-9", {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    const result = calculateCostByModel(byModel, {});

    expect(result.costs.size).toBe(0);
    expect(result.unpriced).toEqual(["claude-brand-new-9"]);
  });

  it("does not report an unpriced model that used no tokens", () => {
    const byModel = new Map<string, TokenMetrics>();
    byModel.set("claude-brand-new-9", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    // Nothing was lost, so nothing should be flagged — a bar marked uncertain
    // on every render is a bar nobody reads.
    expect(calculateCostByModel(byModel, {}).unpriced).toEqual([]);
  });
});

describe("calculateBurnRate", () => {
  const metrics: TokenMetrics = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  const pricing: PricingTable = {
    "claude-sonnet-4-20250514": {
      inputCostPerToken: 3 / 1_000_000,
      outputCostPerToken: 15 / 1_000_000,
      cacheCreationCostPerToken: 3.75 / 1_000_000,
      cacheReadCostPerToken: 0.3 / 1_000_000,
    },
  };

  // 30 minutes of session, $3.00 of input => $6.00/hr.
  const halfHourAgo = () => Date.now() - 30 * 60_000;

  it("reports the cost rate for a priced model", () => {
    const rate = calculateBurnRate(metrics, halfHourAgo(), pricing, "claude-sonnet-4-20250514");
    expect(rate).not.toBeNull();
    expect(rate!.costPerHour).toBeCloseTo(6.0, 2);
    expect(rate!.costPerMinute).toBeCloseTo(0.1, 4);
  });

  it("returns null when the model has no pricing entry", () => {
    // A confident "$0.00/hr" beside real token usage is worse than no
    // segment at all.
    expect(calculateBurnRate(metrics, halfHourAgo(), pricing, "some-unpriced-model")).toBeNull();
  });

  it("returns null when no model is known", () => {
    expect(calculateBurnRate(metrics, halfHourAgo(), pricing)).toBeNull();
  });

  it("returns null without a session start time", () => {
    expect(calculateBurnRate(metrics, null, pricing, "claude-sonnet-4-20250514")).toBeNull();
  });

  it("returns null before 10s of data has accumulated", () => {
    expect(
      calculateBurnRate(metrics, Date.now() - 1000, pricing, "claude-sonnet-4-20250514"),
    ).toBeNull();
  });
});

describe("findPricing fuzzy tie-break (#91)", () => {
  const alias: ModelPricing = {
    inputCostPerToken: 15 / 1_000_000,
    outputCostPerToken: 75 / 1_000_000,
    cacheCreationCostPerToken: 18.75 / 1_000_000,
    cacheReadCostPerToken: 1.5 / 1_000_000,
  };
  const specific: ModelPricing = {
    inputCostPerToken: 5 / 1_000_000,
    outputCostPerToken: 25 / 1_000_000,
    cacheCreationCostPerToken: 6.25 / 1_000_000,
    cacheReadCostPerToken: 0.5 / 1_000_000,
  };

  const MODEL = "claude-opus-4-5-20251101-v1:0";

  // Both keys substring-match the model. First-match-wins made the answer a
  // function of upstream key ordering: one bare alias added to the feed ahead
  // of the dated key charged a 4.5 session at 4.x rates, a 3x overcharge.
  it("picks the same price regardless of key insertion order", () => {
    const aliasFirst: PricingTable = {
      "claude-opus-4": alias,
      "claude-opus-4-5-20251101": specific,
    };
    const specificFirst: PricingTable = {
      "claude-opus-4-5-20251101": specific,
      "claude-opus-4": alias,
    };

    expect(findPricing(MODEL, aliasFirst)).toEqual(findPricing(MODEL, specificFirst));
  });

  it("resolves to the more specific key, not the bare alias", () => {
    const table: PricingTable = {
      "claude-opus-4": alias,
      "claude-opus-4-5-20251101": specific,
    };

    expect(findPricing(MODEL, table)!.inputCostPerToken).toBe(5 / 1_000_000);
  });

  it("still prefers an exact match over any fuzzy candidate", () => {
    const table: PricingTable = {
      "claude-opus-4-5-20251101-v1:0-extra-long-key": alias,
      [MODEL]: specific,
    };

    expect(findPricing(MODEL, table)).toBe(specific);
  });

  it("returns null when nothing matches", () => {
    expect(findPricing("gpt-4", { "claude-opus-4": alias })).toBeNull();
  });
});
