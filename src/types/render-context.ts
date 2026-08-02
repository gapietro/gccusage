import type { StatusJson } from "./status-json.js";
import type { AggregatedMetrics } from "./token-metrics.js";
import type { BlockMetrics } from "./block-metrics.js";
import type { BurnRate } from "./burn-rate.js";
import type { PricingTable } from "./pricing.js";

export interface AlertsConfig {
  sessionWarn: number;
  sessionDanger: number;
  dailyWarn: number;
  dailyDanger: number;
}

export interface RenderContext {
  stdin: StatusJson;
  metrics: AggregatedMetrics;
  block: BlockMetrics | null;
  burnRate: BurnRate | null;
  pricing: PricingTable;
  sessionCostUsd: number;
  todayCostUsd: number;
  costByModel: Map<string, number>;
  /**
   * Models that carried tokens but had no price, so their usage is absent
   * from `costByModel`. Reported whatever the cost source is, because
   * per-model-breakdown renders straight off the pricing table.
   */
  unpricedModels: string[];
  /**
   * True when `sessionCostUsd` was derived from the pricing table and that
   * table was missing a model, so the figure understates the session. False
   * for a stdin-sourced cost, which no missing price can affect.
   */
  sessionCostUncertain: boolean;
  /** As `sessionCostUncertain`, for `todayCostUsd`. */
  todayCostUncertain: boolean;
  sessionStartTime: number | null;
  /** True terminal width, or undefined when it cannot be determined. */
  terminalWidth: number | undefined;
  alerts: AlertsConfig;
  turnCount: number;
}
