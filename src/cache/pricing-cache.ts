import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { sanitisePricingTable } from "../data/pricing-validation.js";
import type { PricingTable } from "../types/pricing.js";

interface PricingCacheFile {
  version: number;
  timestamp: number;
  data: PricingTable;
}

/**
 * Bumped whenever the cached envelope's meaning changes in a way an OLD
 * reader would misinterpret and a NEW reader must not accept from an old
 * file. #103 added the above-200k tier to every parser and to the snapshot
 * this cache falls back to; a pre-tier file merged whole-entry over that
 * snapshot would shadow the new tier for up to the cache's full TTL. Exported
 * so a test can pin the exact value rather than restating it.
 */
export const PRICING_CACHE_VERSION = 1;

// The envelope is validated as a whole; `data` is left as unknown values and
// filtered per entry below, so one corrupted price drops one model rather than
// the whole table (#92). `version` is required and pinned to the current
// value: a missing or stale version is rejected here rather than merely
// ignored, so a pre-upgrade cache degrades to FALLBACK_PRICING (which now
// carries the tiers) instead of silently shadowing it.
const PricingCacheSchema = v.object({
  version: v.literal(PRICING_CACHE_VERSION),
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
    const cache: PricingCacheFile = { version: PRICING_CACHE_VERSION, timestamp: Date.now(), data };
    writeJsonAtomic(cachePath, cache);
  } catch {
    // ignore
  }
}
