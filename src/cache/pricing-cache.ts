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

export function loadPricingCache(ttlMs: number): PricingTable | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(raw) as PricingCacheFile;
    if (Date.now() - cache.timestamp < ttlMs) {
      return cache.data;
    }
  } catch {
    // ignore
  }
  return null;
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
