import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir } from "../utils/paths.js";
import { writeJsonAtomic } from "../utils/atomic-json.js";
import type { PricingTable } from "../types/pricing.js";

interface PricingCacheFile {
  timestamp: number;
  data: PricingTable;
}

function getCachePath(): string {
  return path.join(getCacheDir(), "pricing.json");
}

export interface PricingCacheEntry {
  data: PricingTable;
  ageMs: number;
}

/**
 * Loads the cache regardless of age and reports how old it is, leaving the
 * age policy to the caller. The render path and the CLI want different
 * answers from the same file: the render path serves a stale table (and
 * refreshes out of band) rather than block, while an age ceiling decides when
 * the table is too old to price from at all.
 */
export function loadPricingCacheEntry(): PricingCacheEntry | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(raw) as PricingCacheFile;
    if (typeof cache?.timestamp !== "number" || !cache.data) return null;
    return { data: cache.data, ageMs: Date.now() - cache.timestamp };
  } catch {
    return null;
  }
}

export function loadPricingCache(ttlMs: number): PricingTable | null {
  const entry = loadPricingCacheEntry();
  if (!entry) return null;
  return entry.ageMs < ttlMs ? entry.data : null;
}

export function savePricingCache(data: PricingTable): void {
  const cachePath = getCachePath();
  try {
    const cache: PricingCacheFile = { timestamp: Date.now(), data };
    writeJsonAtomic(cachePath, cache);
  } catch {
    // ignore
  }
}
