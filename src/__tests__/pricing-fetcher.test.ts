import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchPricing } from "../data/pricing-fetcher.js";
import { FALLBACK_PRICING } from "../data/fallback-pricing.js";
import { findPricing } from "../data/cost-calculator.js";
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

function writeCache(data: PricingTable, ageMs = 0): void {
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  fs.writeFileSync(
    cachePath(),
    JSON.stringify({ timestamp: Date.now() - ageMs, data }),
  );
}

const CACHED_TABLE: PricingTable = {
  [CACHED_ONLY]: {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 2 / 1_000_000,
    cacheCreationCostPerToken: 1 / 1_000_000,
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
