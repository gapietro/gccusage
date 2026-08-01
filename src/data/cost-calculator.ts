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

export function calculateCostByModel(
  byModel: Map<string, TokenMetrics>,
  pricing: PricingTable,
): Map<string, number> {
  const costs = new Map<string, number>();
  for (const [model, metrics] of byModel) {
    const modelPricing = findPricing(model, pricing);
    if (modelPricing) {
      costs.set(model, calculateCost(metrics, modelPricing));
    }
  }
  return costs;
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

  // Fuzzy match: find a key that contains the model base name
  for (const key of Object.keys(table)) {
    if (key.includes(model) || model.includes(key)) {
      return table[key]!;
    }
  }

  return null;
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

  // Estimate cost rate
  let costPerMinute = 0;
  if (sessionModel) {
    const modelPricing = findPricing(sessionModel, pricing);
    if (modelPricing) {
      const sessionCost = calculateCost(sessionMetrics, modelPricing);
      costPerMinute = sessionCost / elapsedMinutes;
    }
  }

  return {
    costPerHour: costPerMinute * 60,
    costPerMinute,
  };
}
