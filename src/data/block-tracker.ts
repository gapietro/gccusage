import type { BlockMetrics } from "../types/block-metrics.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";
import { loadBlockCache, saveBlockCache } from "../cache/block-cache.js";

export function detectBlock(sessionStartTime: number | null): BlockMetrics | null {
  const now = Date.now();

  // Try loading cached block start
  const cached = loadBlockCache();
  if (cached) {
    const elapsed = now - cached.blockStartTime;
    if (elapsed < BLOCK_DURATION_MS) {
      return {
        blockStartTime: cached.blockStartTime,
        elapsedMs: elapsed,
        remainingMs: BLOCK_DURATION_MS - elapsed,
        blockDurationMs: BLOCK_DURATION_MS,
      };
    }
    // Block expired, check if we need to start a new one
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
