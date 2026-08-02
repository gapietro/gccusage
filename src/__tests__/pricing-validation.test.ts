import { describe, it, expect } from "vitest";
import {
  MAX_COST_PER_TOKEN,
  isSaneModelPricing,
  sanitisePricingTable,
  anchorToSnapshot,
} from "../data/pricing-validation.js";
import type { ModelPricing, PricingTable } from "../types/pricing.js";

function pricing(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
    ...overrides,
  };
}

describe("isSaneModelPricing", () => {
  it("accepts a real Opus-scale price", () => {
    expect(isSaneModelPricing(pricing())).toBe(true);
  });

  it("accepts a zero cache-read cost", () => {
    expect(isSaneModelPricing(pricing({ cacheReadCostPerToken: 0 }))).toBe(true);
  });

  // A zero input cost renders a confident $0.00 for a real session exactly as
  // a missing table did (#82). That is a broken record, not a free model.
  it("rejects a zero input cost", () => {
    expect(isSaneModelPricing(pricing({ inputCostPerToken: 0 }))).toBe(false);
  });

  it("rejects a negative cost", () => {
    expect(isSaneModelPricing(pricing({ outputCostPerToken: -1 }))).toBe(false);
  });

  it("rejects a cost above the ceiling", () => {
    expect(
      isSaneModelPricing(pricing({ outputCostPerToken: MAX_COST_PER_TOKEN * 2 })),
    ).toBe(false);
  });

  it("rejects a non-numeric cost", () => {
    expect(isSaneModelPricing({ ...pricing(), inputCostPerToken: "3e-6" })).toBe(false);
  });

  it("rejects a missing cost field", () => {
    const { cacheReadCostPerToken: _omitted, ...partial } = pricing();
    expect(isSaneModelPricing(partial)).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isSaneModelPricing(null)).toBe(false);
    expect(isSaneModelPricing(42)).toBe(false);
  });
});

describe("sanitisePricingTable", () => {
  it("drops only the offending entry", () => {
    const result = sanitisePricingTable({
      good: pricing(),
      poisoned: pricing({ outputCostPerToken: 1 }),
      junk: "not-an-object",
    });
    expect(Object.keys(result)).toEqual(["good"]);
  });
});

describe("anchorToSnapshot", () => {
  const snapshot: PricingTable = { "claude-known": pricing() };

  it("keeps an entry that matches the snapshot", () => {
    const result = anchorToSnapshot({ "claude-known": pricing() }, snapshot);
    expect(result["claude-known"]).toBeDefined();
  });

  it("keeps an entry within the deviation band", () => {
    const result = anchorToSnapshot(
      { "claude-known": pricing({ outputCostPerToken: 30 / 1_000_000 }) },
      snapshot,
    );
    expect(result["claude-known"]).toBeDefined();
  });

  // The attack the issue describes: a value that passes bounds comfortably but
  // is nothing like the price we shipped.
  it("rejects an entry that deviates beyond the band", () => {
    const result = anchorToSnapshot(
      { "claude-known": pricing({ outputCostPerToken: 15 / 1_000 }) },
      snapshot,
    );
    expect(result["claude-known"]).toBeUndefined();
  });

  it("rejects an entry priced far below the snapshot", () => {
    const result = anchorToSnapshot(
      { "claude-known": pricing({ inputCostPerToken: 3 / 1_000_000_000 }) },
      snapshot,
    );
    expect(result["claude-known"]).toBeUndefined();
  });

  it("lets a model absent from the snapshot through", () => {
    const result = anchorToSnapshot({ "claude-brand-new": pricing() }, snapshot);
    expect(result["claude-brand-new"]).toBeDefined();
  });

  it("rejects one entry without disturbing its table-mates", () => {
    const result = anchorToSnapshot(
      {
        "claude-known": pricing({ outputCostPerToken: 15 / 1_000 }),
        "claude-brand-new": pricing(),
      },
      snapshot,
    );
    expect(Object.keys(result)).toEqual(["claude-brand-new"]);
  });

  it("defaults to the shipped snapshot", () => {
    // Called with one argument, so FALLBACK_PRICING is the anchor. A known
    // model priced 1000x high must not survive.
    const result = anchorToSnapshot({
      "claude-haiku-4-5": pricing({ inputCostPerToken: 1 / 1_000 }),
    });
    expect(result["claude-haiku-4-5"]).toBeUndefined();
  });
});
