import type { PricingTable, ModelPricing } from "../types/pricing.js";
import { loadPricingCache, savePricingCache } from "../cache/pricing-cache.js";
import { FALLBACK_PRICING } from "./fallback-pricing.js";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export function parseLitellmPricing(data: Record<string, unknown>): PricingTable {
  const table: PricingTable = {};

  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("claude-") || typeof value !== "object" || !value) continue;
    const model = value as Record<string, unknown>;

    const inputCost = model["input_cost_per_token"];
    const outputCost = model["output_cost_per_token"];
    if (typeof inputCost !== "number" || typeof outputCost !== "number") continue;

    const pricing: ModelPricing = {
      inputCostPerToken: inputCost,
      outputCostPerToken: outputCost,
      cacheCreationCostPerToken:
        typeof model["cache_creation_input_token_cost"] === "number"
          ? model["cache_creation_input_token_cost"]
          : inputCost * 1.25,
      cacheReadCostPerToken:
        typeof model["cache_read_input_token_cost"] === "number"
          ? model["cache_read_input_token_cost"]
          : inputCost * 0.1,
    };

    // Store with the raw key (e.g. "claude/claude-sonnet-4-20250514" and also the model id)
    const modelId = key.includes("/") ? key.split("/").pop()! : key;
    table[modelId] = pricing;
    if (key !== modelId) table[key] = pricing;
  }

  return table;
}

/**
 * The offline snapshot is merged UNDER every table this returns, never
 * returned on its own path only. It used to be merged on the fetch-success
 * path alone: the cache stored the un-merged fetch and the cache-hit path
 * returned it raw, so the fallback stopped contributing anything from the
 * second run onward (#93). Live prices always win — a stale snapshot must
 * never override the feed.
 */
export async function fetchPricing(ttlMs: number): Promise<PricingTable> {
  // Try cache first
  const cached = loadPricingCache(ttlMs);
  if (cached) return { ...FALLBACK_PRICING, ...cached };

  // Try fetching from LiteLLM
  try {
    const response = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const pricing = parseLitellmPricing(data);
      if (Object.keys(pricing).length > 0) {
        savePricingCache(pricing);
        return { ...FALLBACK_PRICING, ...pricing };
      }
    }
  } catch {
    // network error, use fallback
  }

  return { ...FALLBACK_PRICING };
}
