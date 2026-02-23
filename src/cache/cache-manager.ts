import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

interface CacheEntry {
  output: string;
  timestamp: number;
  pid: number;
}

function getCachePath(): string {
  return path.join(getCacheDir(), "statusline-cache.json");
}

export function checkCache(ttlMs: number): string | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;

    // TTL check
    if (Date.now() - entry.timestamp > ttlMs) return null;

    // PID deadlock protection: if the PID that wrote is dead, invalidate
    if (entry.pid && entry.pid !== process.pid) {
      try {
        process.kill(entry.pid, 0); // check if alive
      } catch {
        // process is dead, cache might be stale
        return null;
      }
    }

    return entry.output;
  } catch {
    return null;
  }
}

export function writeCache(output: string): void {
  const cachePath = getCachePath();
  try {
    ensureDir(path.dirname(cachePath));
    const entry: CacheEntry = {
      output,
      timestamp: Date.now(),
      pid: process.pid,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry));
  } catch {
    // ignore
  }
}
