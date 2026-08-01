import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  sessionId?: string;
  costUsd?: number;
  terminalWidth?: number;
}

function getCachePath(): string {
  return path.join(getCacheDir(), "statusline-cache.json");
}

export function checkCache(
  ttlMs: number,
  sessionId?: string,
  costUsd?: number,
  terminalWidth?: number,
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

    // Layout depends on terminal width (compact.mode: "auto" collapses the
    // bar below a threshold), so a cached entry laid out for a different
    // width is wrong output, not just stale — a resize must miss even
    // though session and cost are unchanged. Exact match (both undefined
    // also matches) mirrors the cost check above.
    if (entry.terminalWidth !== terminalWidth) return null;

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
  terminalWidth?: number,
): void {
  const cachePath = getCachePath();
  try {
    ensureDir(path.dirname(cachePath));
    const entry: CacheEntry = {
      output,
      timestamp: Date.now(),
      sessionId,
      costUsd,
      terminalWidth,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry));
  } catch {
    // ignore
  }
}
