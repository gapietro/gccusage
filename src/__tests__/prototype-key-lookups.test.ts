import { describe, it, expect } from "vitest";
import { getWidget } from "../widgets/registry.js";
import { getTheme, THEMES } from "../render/themes.js";
import {
  calculateBurnRate,
  calculateCostByModel,
  calculateTotalCost,
  findPricing,
} from "../data/cost-calculator.js";
import { anchorToSnapshot, sanitisePricingTable } from "../data/pricing-validation.js";
import type { ModelPricing, PricingTable } from "../types/pricing.js";
import type { TokenMetrics } from "../types/token-metrics.js";

/**
 * #143 — the #141 bug class at every lookup that takes a key from outside the
 * program: a plain-object read `obj[key]` walks the prototype chain, so a key
 * naming an `Object.prototype` member resolves to an inherited function or
 * object instead of "not found". Config supplies widget types and theme names;
 * transcripts and stdin supply model ids. Each non-control test below fails
 * against the old `obj[key] ?? fallback` / `if (table[key])` lookups, except
 * "does not pollute Object.prototype", a property that must hold before and
 * after and backs the item-3 dismissal.
 */
const PROTOTYPE_KEYS = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

const RATES: ModelPricing = {
  inputCostPerToken: 5 / 1_000_000,
  outputCostPerToken: 25 / 1_000_000,
  cacheCreationCostPerToken: 6.25 / 1_000_000,
  cacheCreation1hCostPerToken: 10 / 1_000_000,
  cacheReadCostPerToken: 0.5 / 1_000_000,
};

function metrics(inputTokens: number, outputTokens: number): TokenMetrics {
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
  };
}

describe("widget registry (#143)", () => {
  it.each(PROTOTYPE_KEYS)("treats widget type %j as unknown, like any other unknown type", (key) => {
    // An unknown type is skipped by the renderer; an inherited `Object` or
    // function used to come back here and throw `widget.render is not a function`.
    expect(getWidget(key)).toBeNull();
  });

  it("still resolves a registered type (control)", () => {
    expect(getWidget("model")).not.toBeNull();
  });
});

describe("theme lookup (#143)", () => {
  it.each(PROTOTYPE_KEYS)("falls back to the default theme for %j", (key) => {
    expect(getTheme(key)).toBe(THEMES["default"]);
  });

  it("still resolves a named theme (control)", () => {
    expect(getTheme("minimal")).toBe(THEMES["minimal"]);
  });
});

describe("findPricing (#143)", () => {
  const table: PricingTable = { "claude-opus-4-6": RATES };

  it.each(PROTOTYPE_KEYS)("finds no price for model id %j", (key) => {
    expect(findPricing(key, table)).toBeNull();
  });

  it.each(PROTOTYPE_KEYS)("finds no price for %j through the claude/ prefix strip", (key) => {
    expect(findPricing(`claude/${key}`, table)).toBeNull();
  });
});

describe("calculateCostByModel (#143)", () => {
  it.each(PROTOTYPE_KEYS)(
    "reports model %j as unpriced and keeps the priced total finite",
    (key) => {
      const byModel = new Map<string, TokenMetrics>([
        ["claude-opus-4-6", metrics(1000, 1000)],
        [key, metrics(1000, 1000)],
      ]);

      const result = calculateCostByModel(byModel, { "claude-opus-4-6": RATES });

      // Unpriced, not priced at NaN: the bar marks the total uncertain and
      // keeps the part it could price, as it does for any unknown model.
      expect(result.unpriced).toEqual([key]);
      expect(result.costs.has(key)).toBe(false);
      expect(calculateTotalCost(result.costs)).toBeCloseTo(0.03, 10);
    },
  );
});

describe("calculateBurnRate (#143)", () => {
  it.each(PROTOTYPE_KEYS)("drops the rate for stdin model id %j rather than rendering NaN", (key) => {
    const rate = calculateBurnRate(
      metrics(1_000_000, 0),
      Date.now() - 30 * 60_000,
      { "claude-opus-4-6": RATES },
      key,
    );
    expect(rate).toBeNull();
  });
});

describe("a __proto__ key in pricing JSON (#143 item 3)", () => {
  // `JSON.parse` keeps `"__proto__"` as an own key; assigning it onto the
  // plain object `sanitisePricingTable` builds replaces that object's
  // prototype instead of adding an entry. Local to the one object — nothing
  // global is polluted — and with own-key lookups nothing inherited from the
  // swapped prototype is reachable as a price.
  const cached = JSON.parse(
    JSON.stringify({ "claude-opus-4-6": RATES }).replace("{", `{"__proto__":${JSON.stringify(RATES)},`),
  ) as Record<string, unknown>;

  it("builds the fixture it claims to (control)", () => {
    expect(Object.hasOwn(cached, "__proto__")).toBe(true);
    const table = sanitisePricingTable(cached);
    expect(Object.getPrototypeOf(table)).not.toBe(Object.prototype);
  });

  it("does not pollute Object.prototype", () => {
    sanitisePricingTable(cached);
    expect(({} as Record<string, unknown>)["inputCostPerToken"]).toBeUndefined();
  });

  it("exposes nothing from the swapped prototype as a price", () => {
    const table = sanitisePricingTable(cached);
    expect(findPricing("__proto__", table)).toBeNull();
    expect(findPricing("inputCostPerToken", table)).toBeNull();
    expect(findPricing("claude-opus-4-6", table)).toEqual(RATES);
  });
});

describe("anchorToSnapshot (#143)", () => {
  it("treats a feed model named after a prototype member as new, not as a snapshot model", () => {
    // `snapshot["constructor"]` used to resolve to `Object`, so the entry was
    // compared against undefined rates and rejected. The snapshot has no such
    // model, so it takes the documented new-model path: bounds alone.
    const result = anchorToSnapshot({ constructor: RATES }, { "claude-opus-4-6": RATES });
    expect(Object.hasOwn(result, "constructor")).toBe(true);
  });
});
