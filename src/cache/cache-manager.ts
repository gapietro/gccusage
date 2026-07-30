import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  sessionId?: string;
}

function getCachePath(): string {
  return path.join(getCacheDir(), "statusline-cache.json");
}

export function checkCache(ttlMs: number, sessionId?: string): string | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;

    // Require exact session match (both undefined also matches)
    if (entry.sessionId !== sessionId) return null;

    // TTL check
    if (Date.now() - entry.timestamp > ttlMs) return null;

    return entry.output;
  } catch {
    return null;
  }
}

export function writeCache(output: string, sessionId?: string): void {
  const cachePath = getCachePath();
  try {
    ensureDir(path.dirname(cachePath));
    const entry: CacheEntry = {
      output,
      timestamp: Date.now(),
      sessionId,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry));
  } catch {
    // ignore
  }
}
