import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir } from "../utils/paths.js";
import { writeJsonAtomic } from "../utils/atomic-json.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";

interface BlockCacheData {
  blockStartTime: number;
}

function getBlockCachePath(): string {
  return path.join(getCacheDir(), "blocks", "current.json");
}

export function loadBlockCache(): BlockCacheData | null {
  const cachePath = getBlockCachePath();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as BlockCacheData;

    // Check if block has expired
    if (Date.now() - data.blockStartTime > BLOCK_DURATION_MS) {
      fs.unlinkSync(cachePath);
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

export function saveBlockCache(data: BlockCacheData): void {
  const cachePath = getBlockCachePath();
  try {
    writeJsonAtomic(cachePath, data);
  } catch {
    // ignore
  }
}
