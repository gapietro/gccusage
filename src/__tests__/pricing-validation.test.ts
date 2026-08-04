import { describe, it, expect } from "vitest";
import {
  MAX_COST_PER_TOKEN,
  isSaneModelPricing,
  sanitisePricingTable,
  sanitiseModelPricing,
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

describe("sanitiseModelPricing tier bounds (#103)", () => {
  const base = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  };

  it("keeps a plausible tier", () => {
    const value = {
      ...base,
      above200k: {
        inputCostPerToken: 0.000006,
        outputCostPerToken: 0.0000225,
        cacheCreationCostPerToken: 0.0000075,
        cacheReadCostPerToken: 0.0000006,
      },
    };
    expect(sanitiseModelPricing(value)?.above200k).toEqual(value.above200k);
  });

  it("strips a tier priced below its standard counterpart, keeping the model", () => {
    const result = sanitiseModelPricing({
      ...base,
      above200k: { ...base, inputCostPerToken: 0.0000001 },
    });

    expect(result).not.toBeNull();
    expect(result!.inputCostPerToken).toBe(base.inputCostPerToken);
    expect(result!.above200k).toBeUndefined();
  });

  it("strips a tier above MAX_COST_PER_TOKEN, keeping the model", () => {
    const result = sanitiseModelPricing({
      ...base,
      above200k: { ...base, outputCostPerToken: MAX_COST_PER_TOKEN * 2 },
    });

    expect(result).not.toBeNull();
    expect(result!.above200k).toBeUndefined();
  });

  it("still drops the model when the base rates fail", () => {
    expect(sanitiseModelPricing({ ...base, inputCostPerToken: 0 })).toBeNull();
  });

  it("passes a model through untouched when it has no tier", () => {
    expect(sanitiseModelPricing(base)).toEqual(base);
  });
});

describe("anchorToSnapshot tier anchoring (#103)", () => {
  const known = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheCreationCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
    above200k: {
      inputCostPerToken: 0.000006,
      outputCostPerToken: 0.0000225,
      cacheCreationCostPerToken: 0.0000075,
      cacheReadCostPerToken: 0.0000006,
    },
  };
  const snapshot = { "claude-sonnet-4-5": known };

  it("accepts a tier within the deviation bound", () => {
    const fetched = {
      "claude-sonnet-4-5": {
        ...known,
        above200k: { ...known.above200k, inputCostPerToken: 0.0000066 },
      },
    };
    expect(anchorToSnapshot(fetched, snapshot)["claude-sonnet-4-5"]).toBeDefined();
  });

  it("rejects a model whose tier drifted beyond the deviation bound", () => {
    const fetched = {
      "claude-sonnet-4-5": {
        ...known,
        above200k: { ...known.above200k, inputCostPerToken: 0.000006 * 20 },
      },
    };
    expect(anchorToSnapshot(fetched, snapshot)["claude-sonnet-4-5"]).toBeUndefined();
  });

  it("accepts a newly published tier the snapshot has no counterpart for", () => {
    const snapshotWithoutTier = { "claude-opus-5": { ...known, above200k: undefined } };
    const fetched = { "claude-opus-5": known };
    expect(anchorToSnapshot(fetched, snapshotWithoutTier)["claude-opus-5"]?.above200k).toBeDefined();
  });

  // The reverse of the case above, and not an inert symmetry: `refreshPricing`
  // runs `parseLitellmPricing` (which strips a malformed tier via
  // `sanitiseModelPricing`) before this anchor ever sees the entry, so a
  // poisoned tier reaches here as a tier-less fetched entry. It passes,
  // matching the documented one-sided rule, and the model prices at standard
  // rates for its premium band rather than losing the entry entirely.
  it("accepts a fetched entry with no tier when the snapshot has one", () => {
    const fetchedWithoutTier = { "claude-sonnet-4-5": { ...known, above200k: undefined } };
    const result = anchorToSnapshot(fetchedWithoutTier, snapshot);
    expect(result["claude-sonnet-4-5"]).toBeDefined();
    expect(result["claude-sonnet-4-5"]?.above200k).toBeUndefined();
  });
});
