import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  key: string;
}

// The cast this replaces checked nothing at runtime (#92). JSON cannot encode
// NaN or Infinity, so v.number() is sufficient at this boundary.
//
// `key` is required, so an entry written by a version that keyed on the old
// (sessionId, costUsd, terminalWidth) triple fails validation and is treated
// as a miss — the next render overwrites it.
const CacheEntrySchema = v.object({
  output: v.string(),
  timestamp: v.number(),
  key: v.string(),
});

function getCachePath(): string {
  return path.join(getCacheDir(), "statusline-cache.json");
}

export function checkCache(ttlMs: number, key: string): string | null {
  const entry = readJsonValidated(getCachePath(), CacheEntrySchema);
  if (!entry) return null;

  // The key covers every render input the bar depends on — see
  // computeCacheKey. A different key is not a stale bar but a wrong one, so
  // it misses regardless of how recent the entry is.
  if (entry.key !== key) return null;

  // TTL check
  if (Date.now() - entry.timestamp > ttlMs) return null;

  return entry.output;
}

export function writeCache(output: string, key: string): void {
  const cachePath = getCachePath();
  try {
    const entry: CacheEntry = { output, timestamp: Date.now(), key };
    writeJsonAtomic(cachePath, entry);
  } catch {
    // ignore
  }
}
