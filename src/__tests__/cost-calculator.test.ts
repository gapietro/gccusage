import { describe, it, expect } from "vitest";
import { calculateCost, calculateCostByModel, findPricing } from "../data/cost-calculator.js";
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
