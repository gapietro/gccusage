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

describe("findPricing forward/reverse direction preference (#108)", () => {
  // Reproduction of the confirmed finding: longest-key-wins alone let a
  // snapshot-absent superset alias outrank a correctly anchored key, because
  // the alias only matched in reverse (table key contains the model) while
  // being longer than the anchored key. Ranking forward matches (model
  // contains table key) above reverse matches closes this without touching
  // anchorToSnapshot or the cost bounds.
  it("prefers an anchored key matched forward over a longer snapshot-absent alias matched only in reverse", () => {
    const anchored: ModelPricing = {
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.000025,
      cacheCreationCostPerToken: 0.00000625,
      cacheReadCostPerToken: 0.0000005,
    };
    // Snapshot-absent alias, priced ~100x the real rate — this is the
    // poisoned entry that passes isSaneModelPricing on bounds alone because
    // it has no FALLBACK_PRICING counterpart to anchor against.
    const poisonedAlias: ModelPricing = {
      inputCostPerToken: 0.0005,
      outputCostPerToken: 0.0009,
      cacheCreationCostPerToken: 0.000625,
      cacheReadCostPerToken: 0.00005,
    };

    const table: PricingTable = {
      "claude-opus-5": anchored,
      "claude-opus-5[1m]-preview": poisonedAlias,
    };

    const result = findPricing("claude-opus-5[1m]", table);

    expect(result).toBe(anchored);
    expect(result!.inputCostPerToken).toBe(0.000005);
  });

  // The demotion of reverse matches must not remove reverse as a fallback:
  // when nothing matches forward, a containing table key still has to
  // resolve the model, or a legitimate lookup silently starts failing.
  it("still resolves via a reverse (containing-key) match when no forward match exists", () => {
    const onlyPricing: ModelPricing = {
      inputCostPerToken: 5 / 1_000_000,
      outputCostPerToken: 25 / 1_000_000,
      cacheCreationCostPerToken: 6.25 / 1_000_000,
      cacheReadCostPerToken: 0.5 / 1_000_000,
    };
    const table: PricingTable = {
      "claude-opus-4-5-20251101-v1:0": onlyPricing,
    };

    // "opus-4-5" does not contain the table key (no forward match), but the
    // table key contains "opus-4-5" (reverse match) and is the only
    // candidate.
    expect(findPricing("opus-4-5", table)).toBe(onlyPricing);
  });
});
