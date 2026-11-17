import type { BlockMetrics } from "../types/block-metrics.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";
import { loadBlockCache, saveBlockCache } from "../cache/block-cache.js";

export function detectBlock(sessionStartTime: number | null): BlockMetrics | null {
  const now = Date.now();

  // A cached block comes back only while it is running, with an elapsed time
  // already judged against the clock — never re-derived here (COR-006).
  const cached = loadBlockCache(now);
  if (cached) {
    return {
      blockStartTime: cached.blockStartTime,
      elapsedMs: cached.elapsedMs,
      remainingMs: BLOCK_DURATION_MS - cached.elapsedMs,
      blockDurationMs: BLOCK_DURATION_MS,
    };
  }

  // Use session start as block start if available
  if (sessionStartTime !== null) {
    const elapsed = now - sessionStartTime;
    if (elapsed < BLOCK_DURATION_MS) {
      saveBlockCache({ blockStartTime: sessionStartTime });
      return {
        blockStartTime: sessionStartTime,
        elapsedMs: elapsed,
        remainingMs: BLOCK_DURATION_MS - elapsed,
        blockDurationMs: BLOCK_DURATION_MS,
      };
    }
  }

  return null;
}
