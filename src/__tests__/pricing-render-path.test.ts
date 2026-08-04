import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPricingForRender, MAX_STALE_MS } from "../data/pricing-fetcher.js";
import { FALLBACK_PRICING } from "../data/fallback-pricing.js";
import { findPricing } from "../data/cost-calculator.js";
import { PRICING_CACHE_VERSION } from "../cache/pricing-cache.js";
import type { PricingTable } from "../types/pricing.js";

/**
 * The render path must never touch the network. The bug (#84) was not the
 * fetch's duration — AbortSignal.timeout fires on time — but that the process
 * outlives the written bar by ~10s while undici's socket holds the event loop
 * open. Claude Code waits for exit, so that is the stall the user sees.
 *
 * A deadline around the fetch does not fix that; only not fetching does.
 * These tests therefore assert on `fetch` never being called, not on timing.
 */

const TTL = 60_000;
const CACHED_ONLY = "claude-cached-only-test";

let tmpDir: string;
let originalXdg: string | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

function cachePath(): string {
  return path.join(tmpDir, "gccusage", "pricing.json");
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
    cacheReadCostPerToken: 0.1 / 1_000_000,
  },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-render-pricing-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;

  // Any call at all is a failure, so this must throw rather than resolve —
  // a stub returning a plausible table would let a regression pass silently.
  fetchSpy = vi.fn(() => {
    throw new Error("render path issued a network request");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("getPricingForRender", () => {
  it("issues no network request when the cache is fresh", () => {
    writeCache(CACHED_TABLE);

    const { pricing, stale } = getPricingForRender(TTL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stale).toBe(false);
    expect(findPricing(CACHED_ONLY, pricing)).not.toBeNull();
  });

  it("issues no network request when the cache is stale", () => {
    writeCache(CACHED_TABLE, TTL * 2);

    const { pricing, stale } = getPricingForRender(TTL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stale).toBe(true);
    // Stale live pricing still beats the shipped snapshot for models it knows.
    expect(findPricing(CACHED_ONLY, pricing)).not.toBeNull();
  });

  it("issues no network request when there is no cache at all", () => {
    const { pricing, stale } = getPricingForRender(TTL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stale).toBe(true);
    expect(findPricing("claude-opus-5", pricing)).toEqual(FALLBACK_PRICING["claude-opus-5"]);
  });

  it("discards a cache past MAX_STALE_MS rather than pricing from it", () => {
    // A machine offline for months would otherwise prefer an ancient cache
    // over a fallback table generated at the last release.
    writeCache(CACHED_TABLE, MAX_STALE_MS + 60_000);

    const { pricing, stale } = getPricingForRender(TTL);

    expect(findPricing(CACHED_ONLY, pricing)).toBeNull();
    expect(stale).toBe(true);
    expect(findPricing("claude-opus-5", pricing)).toEqual(FALLBACK_PRICING["claude-opus-5"]);
  });

  it("merges the fallback under the cache on every path (#93)", () => {
    writeCache(CACHED_TABLE, TTL * 2);

    const { pricing } = getPricingForRender(TTL);

    expect(findPricing(CACHED_ONLY, pricing)).not.toBeNull();
    expect(findPricing("claude-opus-5", pricing)).toEqual(FALLBACK_PRICING["claude-opus-5"]);
  });

  it("lets the cached price win over the fallback for the same model", () => {
    writeCache({ ...CACHED_TABLE, "claude-opus-5": CACHED_TABLE[CACHED_ONLY]! });

    const { pricing } = getPricingForRender(TTL);

    expect(pricing["claude-opus-5"]).toEqual(CACHED_TABLE[CACHED_ONLY]);
  });
});
