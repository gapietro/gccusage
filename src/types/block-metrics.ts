export interface BlockMetrics {
  blockStartTime: number;
  elapsedMs: number;
  remainingMs: number;
  blockDurationMs: number;
}

export const BLOCK_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours
