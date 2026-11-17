import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { writeJsonAtomic, readJsonValidated } from "../utils/atomic-json.js";
import { ageSince, persistedTimestamp } from "../utils/schemas.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";

const BlockCacheSchema = v.object({
  blockStartTime: persistedTimestamp(),
});

type BlockCacheData = v.InferOutput<typeof BlockCacheSchema>;

/** A cached block that is still running, with its trusted elapsed time. */
export interface LiveBlock extends BlockCacheData {
  elapsedMs: number;
}

function getBlockCachePath(): string {
  return path.join(getCacheDir(), "blocks", "current.json");
}

/**
 * The cached block, if it is still running. The one place a cached start is
 * judged: the elapsed time comes back with it so `detectBlock` never
 * re-derives it as `now - blockStartTime`, a second gate that could disagree.
 */
export function loadBlockCache(now: number = Date.now()): LiveBlock | null {
  const cachePath = getBlockCachePath();
  const data = readJsonValidated(cachePath, BlockCacheSchema);
  if (!data) return null;

  // Expired, or started in the future. The second used to read as a block
  // with a negative elapsed time — `-Infinity` for `1e400` — which passed
  // every "still running" check and rendered `Block: ?` until the clock
  // caught up, permanently for `1e400` (COR-006). Deleted either way, so the
  // next render re-derives the block from the session start.
  const elapsedMs = ageSince(data.blockStartTime, now);
  if (elapsedMs === null || elapsedMs >= BLOCK_DURATION_MS) {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      // Already gone, or a concurrent process beat us to it.
    }
    return null;
  }

  return { ...data, elapsedMs };
}

export function saveBlockCache(data: BlockCacheData): void {
  const cachePath = getBlockCachePath();
  try {
    writeJsonAtomic(cachePath, data);
  } catch {
    // ignore
  }
}
