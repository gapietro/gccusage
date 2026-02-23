import type { PricingTable, ModelPricing } from "../types/pricing.js";
import { loadPricingCache, savePricingCache } from "../cache/pricing-cache.js";

// Offline fallback pricing (updated at build time / hardcoded)
const FALLBACK_PRICING: PricingTable = {
  "claude-opus-4-20250514": {
    inputCostPerToken: 15 / 1_000_000,
    outputCostPerToken: 75 / 1_000_000,
    cacheCreationCostPerToken: 18.75 / 1_000_000,
    cacheReadCostPerToken: 1.5 / 1_000_000,
  },
  "claude-sonnet-4-20250514": {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
  },
  "claude-haiku-3.5-20241001": {
    inputCostPerToken: 0.8 / 1_000_000,
    outputCostPerToken: 4 / 1_000_000,
    cacheCreationCostPerToken: 1 / 1_000_000,
    cacheReadCostPerToken: 0.08 / 1_000_000,
  },
};

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

function parseLitellmPricing(data: Record<string, unknown>): PricingTable {
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

export async function fetchPricing(ttlMs: number): Promise<PricingTable> {
  // Try cache first
  const cached = loadPricingCache(ttlMs);
  if (cached) return cached;

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

  return FALLBACK_PRICING;
}
