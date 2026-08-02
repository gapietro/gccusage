import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  sessionId?: string;
  costUsd?: number;
  terminalWidth?: number;
}

// The cast this replaces checked nothing at runtime (#92). JSON cannot encode
// NaN or Infinity, so v.number() is sufficient at this boundary.
const CacheEntrySchema = v.object({
  output: v.string(),
  timestamp: v.number(),
  sessionId: v.optional(v.string()),
  costUsd: v.optional(v.number()),
  terminalWidth: v.optional(v.number()),
});

function getCachePath(): string {
  return path.join(getCacheDir(), "statusline-cache.json");
}

export function checkCache(
  ttlMs: number,
  sessionId?: string,
  costUsd?: number,
  terminalWidth?: number,
): string | null {
  const entry = readJsonValidated(getCachePath(), CacheEntrySchema);
  if (!entry) return null;

  // Require exact session match (both undefined also matches)
  if (entry.sessionId !== sessionId) return null;

  // A changed cumulative cost means fresh spend that daily accounting
  // must record via the full pipeline — never serve the cache across it.
  if (entry.costUsd !== costUsd) return null;

  // Layout depends on terminal width (compact.mode: "auto" collapses the
  // bar below a threshold), so a cached entry laid out for a different
  // width is wrong output, not just stale — a resize must miss even
  // though session and cost are unchanged. Exact match (both undefined
  // also matches) mirrors the cost check above.
  if (entry.terminalWidth !== terminalWidth) return null;

  // TTL check
  if (Date.now() - entry.timestamp > ttlMs) return null;

  return entry.output;
}

export function writeCache(
  output: string,
  sessionId?: string,
  costUsd?: number,
  terminalWidth?: number,
): void {
  const cachePath = getCachePath();
  try {
    const entry: CacheEntry = {
      output,
      timestamp: Date.now(),
      sessionId,
      costUsd,
      terminalWidth,
    };
    writeJsonAtomic(cachePath, entry);
  } catch {
    // ignore
  }
}
