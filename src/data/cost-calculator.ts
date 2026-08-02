import type { TokenMetrics } from "../types/token-metrics.js";
import type { PricingTable, ModelPricing } from "../types/pricing.js";
import type { BurnRate } from "../types/burn-rate.js";

export function calculateCost(metrics: TokenMetrics, pricing: ModelPricing): number {
  return (
    metrics.inputTokens * pricing.inputCostPerToken +
    metrics.outputTokens * pricing.outputCostPerToken +
    metrics.cacheCreationTokens * pricing.cacheCreationCostPerToken +
    metrics.cacheReadTokens * pricing.cacheReadCostPerToken
  );
}

export interface CostByModel {
  costs: Map<string, number>;
  /**
   * Models that carried tokens but had no price. Their usage is missing from
   * `costs`, so any total derived from it understates the truth.
   */
  unpriced: string[];
}

/**
 * Returns the skipped models alongside the costs rather than a bare Map. The
 * silent skip is what let a stale offline pricing table render a confident
 * `$0.00` for a real session (#82): the caller could not tell a free session
 * from an unpriced one, because both arrived as an empty Map.
 */
export function calculateCostByModel(
  byModel: Map<string, TokenMetrics>,
  pricing: PricingTable,
): CostByModel {
  const costs = new Map<string, number>();
  const unpriced: string[] = [];

  for (const [model, metrics] of byModel) {
    const modelPricing = findPricing(model, pricing);
    if (modelPricing) {
      costs.set(model, calculateCost(metrics, modelPricing));
    } else if (hasTokens(metrics)) {
      // A model with no tokens loses nothing by going unpriced, and flagging
      // it would mark the bar uncertain on renders where nothing is missing.
      unpriced.push(model);
    }
  }

  return { costs, unpriced };
}

function hasTokens(metrics: TokenMetrics): boolean {
  return (
    metrics.inputTokens > 0 ||
    metrics.outputTokens > 0 ||
    metrics.cacheCreationTokens > 0 ||
    metrics.cacheReadTokens > 0
  );
}

export function calculateTotalCost(costByModel: Map<string, number>): number {
  let total = 0;
  for (const cost of costByModel.values()) {
    total += cost;
  }
  return total;
}

export function findPricing(model: string, table: PricingTable): ModelPricing | null {
  // Exact match
  if (table[model]) return table[model];

  // Try with claude/ prefix stripped
  const stripped = model.replace(/^claude\//, "");
  if (table[stripped]) return table[stripped];

  // Fuzzy match, longest key wins, lexicographic on ties. First-match-wins
  // made the result a function of the upstream table's key ordering (#91):
  // a bare "claude-opus-4" alias appearing before "claude-opus-4-5-20251101"
  // priced a 4.5 session at 4.x rates. Length is the proxy for specificity —
  // the dated key is always the longer one.
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (!key.includes(model) && !model.includes(key)) continue;
    if (
      best === null ||
      key.length > best.length ||
      (key.length === best.length && key < best)
    ) {
      best = key;
    }
  }

  return best === null ? null : table[best]!;
}

export function calculateBurnRate(
  sessionMetrics: TokenMetrics,
  sessionStartTime: number | null,
  pricing: PricingTable,
  sessionModel?: string,
): BurnRate | null {
  if (!sessionStartTime) return null;

  const elapsedMs = Date.now() - sessionStartTime;
  if (elapsedMs < 10000) return null; // need at least 10s of data

  const elapsedMinutes = elapsedMs / 60000;

  // Without pricing there is no cost rate to report. Returning zero here
  // would render a confident "$0.00/hr" next to real token usage, so the
  // segment is dropped instead — the same stance getStdinBurnRate takes when
  // stdin carries no cost.
  if (!sessionModel) return null;
  const modelPricing = findPricing(sessionModel, pricing);
  if (!modelPricing) return null;

  const sessionCost = calculateCost(sessionMetrics, modelPricing);
  const costPerMinute = sessionCost / elapsedMinutes;

  return {
    costPerHour: costPerMinute * 60,
    costPerMinute,
  };
}
