import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { sanitisePricingTable } from "../data/pricing-validation.js";
import type { PricingTable } from "../types/pricing.js";

interface PricingCacheFile {
  timestamp: number;
  data: PricingTable;
}

// The envelope is validated as a whole; `data` is left as unknown values and
// filtered per entry below, so one corrupted price drops one model rather than
// the whole table (#92).
const PricingCacheSchema = v.object({
  timestamp: v.number(),
  data: v.record(v.string(), v.unknown()),
});

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
  const cache = readJsonValidated(getCachePath(), PricingCacheSchema);
  if (!cache) return null;

  // Bounds only, never the snapshot anchor: the anchor is about trusting the
  // feed, these entries already passed it at write time, and re-running it
  // would silently invalidate a legitimately cached price the day someone
  // regenerates the snapshot after a real price move.
  const data = sanitisePricingTable(cache.data);
  if (Object.keys(data).length === 0) return null;

  return { data, ageMs: Date.now() - cache.timestamp };
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
