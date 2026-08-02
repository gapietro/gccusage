import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { writeJsonAtomic, readJsonValidated } from "../utils/atomic-json.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";

const BlockCacheSchema = v.object({
  blockStartTime: v.number(),
});

type BlockCacheData = v.InferOutput<typeof BlockCacheSchema>;

function getBlockCachePath(): string {
  return path.join(getCacheDir(), "blocks", "current.json");
}

export function loadBlockCache(): BlockCacheData | null {
  const cachePath = getBlockCachePath();
  const data = readJsonValidated(cachePath, BlockCacheSchema);
  if (!data) return null;

  // Check if block has expired
  if (Date.now() - data.blockStartTime > BLOCK_DURATION_MS) {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      // Already gone, or a concurrent process beat us to it.
    }
    return null;
  }

  return data;
}

export function saveBlockCache(data: BlockCacheData): void {
  const cachePath = getBlockCachePath();
  try {
    writeJsonAtomic(cachePath, data);
  } catch {
    // ignore
  }
}
