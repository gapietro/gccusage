import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  sessionId?: string;
  costUsd?: number;
}

function getCachePath(): string {
  return path.join(getCacheDir(), "statusline-cache.json");
}

export function checkCache(
  ttlMs: number,
  sessionId?: string,
  costUsd?: number,
): string | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;

    // Require exact session match (both undefined also matches)
    if (entry.sessionId !== sessionId) return null;

    // A changed cumulative cost means fresh spend that daily accounting
    // must record via the full pipeline — never serve the cache across it.
    if (entry.costUsd !== costUsd) return null;

    // TTL check
    if (Date.now() - entry.timestamp > ttlMs) return null;

    return entry.output;
  } catch {
    return null;
  }
}

export function writeCache(
  output: string,
  sessionId?: string,
  costUsd?: number,
): void {
  const cachePath = getCachePath();
  try {
    ensureDir(path.dirname(cachePath));
    const entry: CacheEntry = {
      output,
      timestamp: Date.now(),
      sessionId,
      costUsd,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry));
  } catch {
    // ignore
  }
}
