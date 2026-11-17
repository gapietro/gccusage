import type { BlockMetrics } from "../types/block-metrics.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";
import { loadBlockCache, saveBlockCache } from "../cache/block-cache.js";
import { ageSince } from "../utils/schemas.js";

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

  // Use session start as block start if available. Through `ageSince` like
  // the cached start: a transcript stamp in the future gave a negative
  // elapsed, which passed the check below, returned more than the whole
  // window as remaining, and was SAVED — so every render had loadBlockCache
  // reject and unlink the file and this line write it back. An untrusted start
  // is no block, and is never persisted (COR-006).
  if (sessionStartTime !== null) {
    const elapsed = ageSince(sessionStartTime, now);
    if (elapsed !== null && elapsed < BLOCK_DURATION_MS) {
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
