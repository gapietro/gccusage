import type { TokenMetrics, TokenCounts } from "../types/token-metrics.js";
import type { PricingTable, ModelPricing, RateSet } from "../types/pricing.js";
import type { BurnRate } from "../types/burn-rate.js";

function rateCounts(counts: TokenCounts, rates: RateSet): number {
  // 5-minute writes are the remainder: cacheCreation1hTokens is a SUBSET of
  // cacheCreationTokens, clamped at ingestion so this cannot go negative.
  const cacheCreation5m = counts.cacheCreationTokens - counts.cacheCreation1hTokens;
  return (
    counts.inputTokens * rates.inputCostPerToken +
    counts.outputTokens * rates.outputCostPerToken +
    cacheCreation5m * rates.cacheCreationCostPerToken +
    counts.cacheCreation1hTokens * rates.cacheCreation1hCostPerToken +
    counts.cacheReadTokens * rates.cacheReadCostPerToken
  );
}

/**
 * `metrics.premium` is a SUBSET of the four counts, so standard tokens are the
 * difference. When the model publishes no tier the premium tokens fall back to
 * base rates — an under-count we flag rather than guess at (#103).
 */
export function calculateCost(metrics: TokenMetrics, pricing: ModelPricing): number {
  const premium = metrics.premium;
  if (!premium) return rateCounts(metrics, pricing);

  const standard: TokenCounts = {
    inputTokens: metrics.inputTokens - premium.inputTokens,
    outputTokens: metrics.outputTokens - premium.outputTokens,
    cacheCreationTokens: metrics.cacheCreationTokens - premium.cacheCreationTokens,
    cacheCreation1hTokens: metrics.cacheCreation1hTokens - premium.cacheCreation1hTokens,
    cacheReadTokens: metrics.cacheReadTokens - premium.cacheReadTokens,
  };

  return rateCounts(standard, pricing) + rateCounts(premium, pricing.above200k ?? pricing);
}

export interface CostByModel {
  costs: Map<string, number>;
  /**
   * Models that carried tokens but had no price. Their usage is missing from
   * `costs`, so any total derived from it understates the truth.
   */
  unpriced: string[];
  /**
   * Models that billed tokens above the 200k threshold on a price list that
   * publishes no premium tier, so those tokens are costed at the standard
   * rate. Unlike `unpriced`, their usage IS in `costs` — the figure is a lower
   * bound, not a gap (#103).
   */
  approximated: string[];
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
  const approximated: string[] = [];

  for (const [model, metrics] of byModel) {
    const modelPricing = findPricing(model, pricing);
    if (modelPricing) {
      costs.set(model, calculateCost(metrics, modelPricing));
      if (!modelPricing.above200k && hasPremiumTokens(metrics)) approximated.push(model);
    } else if (hasTokens(metrics)) {
      // A model with no tokens loses nothing by going unpriced, and flagging
      // it would mark the bar uncertain on renders where nothing is missing.
      unpriced.push(model);
    }
  }

  return { costs, unpriced, approximated };
}

function hasTokens(metrics: TokenMetrics): boolean {
  return (
    metrics.inputTokens > 0 ||
    metrics.outputTokens > 0 ||
    metrics.cacheCreationTokens > 0 ||
    metrics.cacheReadTokens > 0
  );
}

function hasPremiumTokens(metrics: TokenMetrics): boolean {
  const premium = metrics.premium;
  return (
    premium !== undefined &&
    (premium.inputTokens > 0 ||
      premium.outputTokens > 0 ||
      premium.cacheCreationTokens > 0 ||
      premium.cacheReadTokens > 0)
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

  // Fuzzy match. A key can match in two directions: forward, where the model
  // id is a longer, provider-qualified string containing a shorter table key
  // ("claude-opus-5[1m]" -> "claude-opus-5", or a Bedrock/Vertex id like
  // "us.anthropic.claude-sonnet-4-5-20250929-v1:0" -> the dated key); or
  // reverse, where the table key instead contains the model. Every
  // legitimate resolution here is forward. Reverse is the direction a
  // poisoned pricing feed exploits: a newly introduced superset alias key
  // that is absent from FALLBACK_PRICING skips snapshot anchoring entirely
  // (anchorToSnapshot only checks keys present in the snapshot, #91) and can
  // still win on length against a shorter, correctly anchored key by
  // matching in reverse. Ranking forward above reverse closes that path
  // without touching bounds or anchoring — reverse is kept only as a
  // fallback for callers with no forward candidate, so no legitimate
  // resolution is lost.
  //
  // Within a direction, longest key wins, lexicographic on ties.
  // First-match-wins made the result a function of the upstream table's key
  // ordering (#91): a bare "claude-opus-4" alias appearing before
  // "claude-opus-4-5-20251101" priced a 4.5 session at 4.x rates. This makes
  // the result deterministic regardless of key ordering, using length as an
  // approximation of specificity — it is not a guarantee that the longest
  // match is the correct one.
  let best: string | null = null;
  let bestIsForward = false;
  for (const key of Object.keys(table)) {
    const forward = model.includes(key);
    const reverse = !forward && key.includes(model);
    if (!forward && !reverse) continue;

    if (best === null) {
      best = key;
      bestIsForward = forward;
      continue;
    }

    if (forward !== bestIsForward) {
      // Direction differs: forward always outranks reverse, regardless of
      // length. Only replace `best` when the candidate is the forward one.
      if (forward) {
        best = key;
        bestIsForward = true;
      }
      continue;
    }

    if (key.length > best.length || (key.length === best.length && key < best)) {
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
