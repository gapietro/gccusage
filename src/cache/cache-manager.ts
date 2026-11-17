import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { ageSince, persistedTimestamp } from "../utils/schemas.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  key: string;
}

// The cast this replaces checked nothing at runtime (#92).
//
// `key` is required, so an entry written by a version that keyed on the old
// (sessionId, costUsd, terminalWidth) triple fails validation and is treated
// as a miss — the next render overwrites it.
const CacheEntrySchema = v.object({
  output: v.string(),
  timestamp: persistedTimestamp(),
  key: v.string(),
});

/** Null when there is no cache dir (SEC-004): every check misses. */
function getCachePath(): string | null {
  const dir = getCacheDir();
  return dir === null ? null : path.join(dir, "statusline-cache.json");
}

export function checkCache(ttlMs: number, key: string): string | null {
  const cachePath = getCachePath();
  if (cachePath === null) return null;
  const entry = readJsonValidated(cachePath, CacheEntrySchema);
  if (!entry) return null;

  // The key covers every render input the bar depends on — see
  // computeCacheKey. A different key is not a stale bar but a wrong one, so
  // it misses regardless of how recent the entry is.
  if (entry.key !== key) return null;

  // A stamp in the future has no trustworthy age; served as fresh, it kept an
  // old bar on screen past its TTL until the clock caught up (COR-006).
  const age = ageSince(entry.timestamp);
  if (age === null || age > ttlMs) return null;

  return entry.output;
}

export function writeCache(output: string, key: string): void {
  const cachePath = getCachePath();
  if (cachePath === null) return;
  try {
    const entry: CacheEntry = { output, timestamp: Date.now(), key };
    writeJsonAtomic(cachePath, entry);
  } catch {
    // ignore
  }
}
