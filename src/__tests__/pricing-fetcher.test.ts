import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchPricing, parseLitellmPricing } from "../data/pricing-fetcher.js";
import { FALLBACK_PRICING } from "../data/fallback-pricing.js";
import { findPricing } from "../data/cost-calculator.js";
import { PRICING_CACHE_VERSION } from "../cache/pricing-cache.js";
import type { PricingTable } from "../types/pricing.js";

/**
 * The offline fallback is only worth having if every path returns it. It used
 * to be merged on the fetch-success path alone (#93): the cache stored the
 * un-merged fetch and the cache-hit path returned it raw, so from the second
 * run onward the fallback contributed nothing at all.
 */

const TTL = 60_000;
const CACHED_ONLY = "claude-cached-only-test";

let tmpDir: string;
let originalXdg: string | undefined;

function cachePath(): string {
  return path.join(tmpDir, "gccusage", "pricing.json");
}

function stubFetchJson(data: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => data })),
  );
}

function writeCache(data: PricingTable, ageMs = 0): void {
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  fs.writeFileSync(
    cachePath(),
    JSON.stringify({ version: PRICING_CACHE_VERSION, timestamp: Date.now() - ageMs, data }),
  );
}

const CACHED_TABLE: PricingTable = {
  [CACHED_ONLY]: {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 2 / 1_000_000,
    cacheCreationCostPerToken: 1 / 1_000_000,
    cacheCreation1hCostPerToken: 2 / 1_000_000,
    cacheReadCostPerToken: 0.1 / 1_000_000,
  },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-pricing-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("fetchPricing", () => {
  it("still prices a fallback model when a fresh cache is used", async () => {
    // The cached table deliberately knows nothing about the shipping models.
    writeCache(CACHED_TABLE);

    const table = await fetchPricing(TTL);

    expect(findPricing(CACHED_ONLY, table)).not.toBeNull();
    expect(findPricing("claude-opus-5", table)).toEqual(FALLBACK_PRICING["claude-opus-5"]);
  });

  it("lets the cached price win over the fallback for the same model", async () => {
    const repriced = { ...CACHED_TABLE, "claude-opus-5": CACHED_TABLE[CACHED_ONLY]! };
    writeCache(repriced);

    const table = await fetchPricing(TTL);

    // Merge order matters: a stale snapshot must never override live pricing.
    expect(table["claude-opus-5"]).toEqual(CACHED_TABLE[CACHED_ONLY]);
  });

  it("prices the shipping models when the network is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );

    const table = await fetchPricing(TTL);

    // The exact failure #82 reports: offline, every current model priced at
    // nothing, so the bar rendered $0.00.
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-6", "claude-fable-5"]) {
      expect(findPricing(id, table), `${id} unpriced offline`).not.toBeNull();
    }
  });

  it("merges the fallback under a successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          "claude-fetched-test": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
        }),
      })),
    );

    const table = await fetchPricing(TTL);

    expect(findPricing("claude-fetched-test", table)).not.toBeNull();
    expect(findPricing("claude-opus-5", table)).toEqual(FALLBACK_PRICING["claude-opus-5"]);
  });

  it("does not serve a cache older than the TTL", async () => {
    writeCache(CACHED_TABLE, TTL * 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const table = await fetchPricing(TTL);

    expect(findPricing(CACHED_ONLY, table)).toBeNull();
  });
});

describe("pricing feed integrity (#91)", () => {
  // The upstream field names, not ours — this is what parseLitellmPricing eats.
  function upstream(input: number, output: number): Record<string, unknown> {
    return { input_cost_per_token: input, output_cost_per_token: output };
  }

  it("drops a model whose price is absurd and keeps its table-mates", () => {
    const table = parseLitellmPricing({
      "claude-sane-test": upstream(3 / 1_000_000, 15 / 1_000_000),
      "claude-absurd-test": upstream(3 / 1_000_000, 5),
    });

    expect(table["claude-sane-test"]).toBeDefined();
    expect(table["claude-absurd-test"]).toBeUndefined();
  });

  it("drops a model priced at zero rather than reporting $0.00 for it", () => {
    const table = parseLitellmPricing({
      "claude-free-test": upstream(0, 0),
    });

    expect(table["claude-free-test"]).toBeUndefined();
  });

  it("rejects a known model whose fetched price deviates from the snapshot", async () => {
    // haiku-4-5 ships in FALLBACK_PRICING at 1e-6 input. 1e-4 is 100x that:
    // comfortably inside the bounds ceiling, nothing like the real price.
    stubFetchJson({
      "claude-haiku-4-5": upstream(1 / 10_000, 5 / 10_000),
    });

    const table = await fetchPricing(TTL);

    expect(table["claude-haiku-4-5"]!.inputCostPerToken).toBe(
      FALLBACK_PRICING["claude-haiku-4-5"]!.inputCostPerToken,
    );
  });

  it("still accepts a fetched price for a model the snapshot has never seen", async () => {
    stubFetchJson({
      "claude-future-9": upstream(9 / 1_000_000, 45 / 1_000_000),
    });

    const table = await fetchPricing(TTL);

    expect(table["claude-future-9"]!.inputCostPerToken).toBe(9 / 1_000_000);
  });
});

describe("parseLitellmPricing above-200k tier (#103)", () => {
  it("reads the published premium rates into above200k", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003,
        input_cost_per_token_above_200k_tokens: 0.000006,
        output_cost_per_token_above_200k_tokens: 0.0000225,
        cache_creation_input_token_cost_above_200k_tokens: 0.0000075,
        cache_read_input_token_cost_above_200k_tokens: 0.0000006,
      },
    });

    expect(table["claude-sonnet-4-5"]!.above200k).toEqual({
      inputCostPerToken: 0.000006,
      outputCostPerToken: 0.0000225,
      cacheCreationCostPerToken: 0.0000075,
      cacheCreation1hCostPerToken: 0.000012,
      cacheReadCostPerToken: 0.0000006,
    });
    // The base rates must be untouched by the tier.
    expect(table["claude-sonnet-4-5"]!.inputCostPerToken).toBe(0.000003);
  });

  it("leaves above200k absent when the feed publishes no tier", () => {
    const table = parseLitellmPricing({
      "claude-opus-5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_creation_input_token_cost: 0.00000625,
        cache_read_input_token_cost: 0.0000005,
      },
    });

    expect(table["claude-opus-5"]).toBeDefined();
    expect(table["claude-opus-5"]!.above200k).toBeUndefined();
  });

  it("requires both premium input and output before attaching a tier", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        input_cost_per_token_above_200k_tokens: 0.000006,
        // no output premium
      },
    });

    expect(table["claude-sonnet-4-5"]!.above200k).toBeUndefined();
  });

  it("derives missing premium cache rates off the premium input rate", () => {
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        input_cost_per_token_above_200k_tokens: 0.000006,
        output_cost_per_token_above_200k_tokens: 0.0000225,
      },
    });

    const tier = table["claude-sonnet-4-5"]!.above200k!;
    expect(tier.cacheCreationCostPerToken).toBeCloseTo(0.000006 * 1.25, 12);
    expect(tier.cacheReadCostPerToken).toBeCloseTo(0.000006 * 0.1, 12);
  });
});

describe("1-hour cache creation rate", () => {
  it("uses the published above_1hr rate", () => {
    // 1.2e-5 is deliberately NOT input x 2 (which would be 1e-5) — a
    // resolveCache1hRate that ignored `published` and always returned the
    // derivation would still pass an expectation of 1e-5. It stays above
    // cacheCreationCost (6.25e-6) so no repair fires and the published value
    // passes straight through, diverging from the derivation. Do not "tidy"
    // this back to a realistic 2x rate; that would silently restore the gap.
    const table = parseLitellmPricing({
      "claude-test-a": {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_creation_input_token_cost: 6.25e-6,
        cache_creation_input_token_cost_above_1hr: 1.2e-5,
      },
    });
    expect(table["claude-test-a"]!.cacheCreation1hCostPerToken).toBe(1.2e-5);
  });

  it("derives input x 2 when the feed publishes no 1-hour rate", () => {
    const table = parseLitellmPricing({
      "claude-test-b": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_creation_input_token_cost: 3.75e-6,
      },
    });
    expect(table["claude-test-b"]!.cacheCreation1hCostPerToken).toBe(6e-6);
  });

  // Real broken record: claude-3-opus-20240229 publishes a 1-hour rate BELOW
  // its own 5-minute rate. A longer TTL cannot cost less, so it is repaired to
  // the derivation (1.5e-5 x 2 = 3e-5), which is Anthropic's real published
  // rate for that model.
  it("repairs a 1-hour rate that undercuts its own 5-minute rate", () => {
    const table = parseLitellmPricing({
      "claude-3-opus-20240229": {
        input_cost_per_token: 1.5e-5,
        output_cost_per_token: 7.5e-5,
        cache_creation_input_token_cost: 1.875e-5,
        cache_creation_input_token_cost_above_1hr: 6e-6,
      },
    });
    expect(table["claude-3-opus-20240229"]!.cacheCreation1hCostPerToken).toBe(3e-5);
  });

  // Documents the DELIBERATE gap in the monotonicity-only rule (spec D2).
  // claude-3-haiku publishes 6e-6 against a 3e-7 five-minute rate — 20x, and
  // wrong — but it is ABOVE its sibling, so monotonicity does not catch it.
  // Claude Code cannot run Haiku 3, so the bad rate is unreachable. If someone
  // later swaps monotonicity for a plausibility band, this test fails and
  // forces them back to spec D2 rather than letting the change pass silently.
  it("does NOT repair an implausible rate that is merely too high", () => {
    const table = parseLitellmPricing({
      "claude-3-haiku-20240307": {
        input_cost_per_token: 2.5e-7,
        output_cost_per_token: 1.25e-6,
        cache_creation_input_token_cost: 3e-7,
        cache_creation_input_token_cost_above_1hr: 6e-6,
      },
    });
    expect(table["claude-3-haiku-20240307"]!.cacheCreation1hCostPerToken).toBe(6e-6);
  });

  it("reads the above-200k cross-product rate onto the tier", () => {
    // The cross-product value (1.5e-5) is deliberately NOT tierInput x 2
    // (which would be 1.2e-5) and is ABOVE the tier's cache-creation cost
    // (7.5e-6), so this test cannot be satisfied by any path other than
    // actually reading TIER_FIELDS.cacheCreation1hAbove200k: misreading the
    // base field (6e-6, below cacheCreationCost) repairs to 1.2e-5, and a
    // parser that ignored the field entirely and derived tierInput x 2 also
    // lands on 1.2e-5. Both wrong answers coincide with each other but not
    // with the correct 1.5e-5 — a derivation cannot masquerade as a read.
    const table = parseLitellmPricing({
      "claude-sonnet-4-5": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_creation_input_token_cost: 3.75e-6,
        cache_creation_input_token_cost_above_1hr: 6e-6,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 2.25e-5,
        cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
        cache_creation_input_token_cost_above_1hr_above_200k_tokens: 1.5e-5,
      },
    });
    expect(table["claude-sonnet-4-5"]!.above200k!.cacheCreation1hCostPerToken).toBe(1.5e-5);
  });

  it("derives the tier's 1-hour rate from the TIER input when absent", () => {
    // The BASE 1-hour field is 9e-6 here, deliberately NOT tierInput x 2
    // (which would be 1.2e-5, coinciding with the correct derivation below).
    // If parseTier misread this base field instead of the (absent) tier
    // field, it would feed 9e-6 into resolveCache1hRate against the tier's
    // own cacheCreationCost (7.5e-6): 9e-6 is NOT below 7.5e-6, so no repair
    // fires and 9e-6 passes straight through — diverging from 1.2e-5. Merely
    // deleting the base field does not close this: `published` would then be
    // undefined and fall through to the same correct derivation, proving
    // nothing. Do not "tidy" this back to a realistic 2x rate.
    const table = parseLitellmPricing({
      "claude-sonnet-4-20250514": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_creation_input_token_cost: 3.75e-6,
        cache_creation_input_token_cost_above_1hr: 9e-6,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 2.25e-5,
        cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
      },
    });
    // 6e-6 (tier input) x 2 — the exact value the three sonnet-4-5 keys publish.
    expect(table["claude-sonnet-4-20250514"]!.above200k!.cacheCreation1hCostPerToken).toBe(1.2e-5);
  });
});
