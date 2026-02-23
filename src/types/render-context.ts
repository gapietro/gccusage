import type { StatusJson } from "./status-json.js";
import type { AggregatedMetrics } from "./token-metrics.js";
import type { BlockMetrics } from "./block-metrics.js";
import type { BurnRate } from "./burn-rate.js";
import type { PricingTable } from "./pricing.js";

export interface RenderContext {
  stdin: StatusJson;
  metrics: AggregatedMetrics;
  block: BlockMetrics | null;
  burnRate: BurnRate | null;
  pricing: PricingTable;
  sessionCostUsd: number;
  todayCostUsd: number;
  costByModel: Map<string, number>;
  sessionStartTime: number | null;
  terminalWidth: number;
}
