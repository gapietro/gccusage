import type { AggregatedMetrics, TokenMetrics } from "../../../types/token-metrics.js";
import type { BlockMetrics } from "../../../types/block-metrics.js";
import type { BurnRate } from "../../../types/burn-rate.js";

/**
 * A real Claude Code statusline payload plus the RenderContext values a real
 * pipeline run derived from it.
 *
 * The derived block is RECORDED, not invented. Hand-written context values are
 * exactly the failure mode #47 exists to close: they encode what we believe the
 * pipeline produces rather than what it does produce.
 */
export interface RealPayloadFixture {
  name: string;
  claudeCodeVersion: string;
  /** Epoch ms at capture. Pins Date.now() so elapsed-time widgets are exact. */
  capturedAt: number;
  /** Absolute path prefix standing in for the real home dir in sanitized paths. */
  homePlaceholder: string;
  /** The raw payload as Claude Code sent it, with identifying values replaced. */
  stdin: Record<string, unknown>;
  derived: {
    /** AggregatedMetrics as recorded, except byModel is entries (Maps don't survive JSON). */
    metrics: Omit<AggregatedMetrics, "byModel"> & { byModel: [string, TokenMetrics][] };
    sessionCostUsd: number;
    todayCostUsd: number;
    /** Map is not JSON-serialisable; stored as entries. */
    costByModel: [string, number][];
    sessionStartTime: number | null;
    turnCount: number;
    block: BlockMetrics | null;
    burnRate: BurnRate | null;
  };
}
