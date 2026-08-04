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
   * Models that billed tokens above the 200k threshold with no published
   * premium rate, so their cost is a lower bound. Distinct from
   * `unpricedModels`: the usage IS counted, just at the standard rate (#103).
   */
  approximatedModels: string[];
  /**
   * True when `sessionCostUsd` was derived from the pricing table and that
   * table was either missing a model or had to approximate one at standard
   * rates, so the figure may understate the session. False for a
   * stdin-sourced cost, which neither a missing price nor a missing premium
   * rate can affect.
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
