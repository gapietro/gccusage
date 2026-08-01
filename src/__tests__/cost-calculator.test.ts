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
    expect(result.size).toBe(1);
    expect(result.get("claude-sonnet-4-20250514")).toBeGreaterThan(0);
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
