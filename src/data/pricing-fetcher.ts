import type { PricingTable, ModelPricing, RateSet } from "../types/pricing.js";
import {
  loadPricingCache,
  loadPricingCacheEntry,
  savePricingCache,
} from "../cache/pricing-cache.js";
import { FALLBACK_PRICING } from "./fallback-pricing.js";
import { anchorToSnapshot, sanitiseModelPricing } from "./pricing-validation.js";
import { TIER_FIELDS, CACHE_1H_FIELD, CACHE_1H_INPUT_MULTIPLIER } from "./pricing-tiers.js";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Overridable so the blackhole test can point at an unroutable address, and so
 * an air-gapped install can aim at an internal mirror. Read per call rather
 * than captured at module load, because the test sets it per case.
 */
export function getPricingUrl(): string {
  return process.env["GCCUSAGE_PRICING_URL"] || LITELLM_URL;
}

/**
 * `ttlMs` says when to REFRESH; this says when the table is too old to price
 * from at all. They are different questions. Serving a stale cache is right —
 * it is real pricing, and the refresh lands within a prompt or two — but a
 * machine that has been offline for months would otherwise prefer a
 * long-dead cache to a FALLBACK_PRICING table generated at the last release.
 */
export const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RenderPricing {
  pricing: PricingTable;
  /** True when the caller should trigger an out-of-band refresh. */
  stale: boolean;
}

/**
 * The pricing the statusline renders with. Does no I/O beyond reading the
 * cache file, and in particular never touches the network (#84).
 *
 * The 10.6s stall was never the fetch's own duration — AbortSignal.timeout
 * fires on schedule. It was that undici keeps the event loop alive long after
 * the bar is written, and Claude Code waits for the process to exit. Putting a
 * deadline around the fetch would have left that untouched.
 */
export function getPricingForRender(ttlMs: number): RenderPricing {
  const entry = loadPricingCacheEntry();
  if (!entry || entry.ageMs >= MAX_STALE_MS) {
    return { pricing: { ...FALLBACK_PRICING }, stale: true };
  }
  return {
    pricing: { ...FALLBACK_PRICING, ...entry.data },
    stale: entry.ageMs >= ttlMs,
  };
}

/**
 * Fetches and caches live pricing. Runs in the detached refresh child and in
 * explicit CLI commands — never on the render path. Returns whether the cache
 * was updated.
 */
export async function refreshPricing(): Promise<boolean> {
  try {
    const response = await fetch(getPricingUrl(), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const data = (await response.json()) as Record<string, unknown>;
    const pricing = anchorToSnapshot(parseLitellmPricing(data));
    if (Object.keys(pricing).length === 0) return false;
    savePricingCache(pricing);
    return true;
  } catch {
    return false;
  }
}

/**
 * A 1-hour cache write costs more than a 5-minute one, always — a longer TTL
 * cannot be cheaper. A published rate that undercuts its own 5-minute sibling
 * is therefore a corrupted record, not a price, and resolves to the derivation
 * instead.
 *
 * This REPAIRS where `isSaneTier` REJECTS, and the asymmetry is deliberate:
 * a tier can be stripped and the model still prices at standard rates, but
 * this field is required and has no safe absence state, so rejecting would
 * mean dropping the whole model over one bad sibling — regressing the
 * per-entry posture of #92. Repair degrades to exactly the value the model
 * would have taken had the feed stayed silent.
 *
 * Deliberately NOT a plausibility band. Monotonicity is a fact about how
 * caching works and cannot go stale; a band is a calibration that would
 * eventually reject a genuine repricing (#91's documented accepted risk).
 * The cost is that `claude-3-haiku`'s 20x value survives — unreachable in
 * practice, since Claude Code cannot run Haiku 3 (spec D2).
 */
function resolveCache1hRate(
  published: unknown,
  inputCost: number,
  cacheCreationCost: number,
): number {
  const derived = inputCost * CACHE_1H_INPUT_MULTIPLIER;
  if (typeof published !== "number" || !Number.isFinite(published)) return derived;
  return published < cacheCreationCost ? derived : published;
}

/**
 * The feed publishes the long-context tier as four sibling fields rather than
 * a nested object. Both premium input and output must be present before a
 * tier is attached: a half-published tier would charge premium input against
 * standard output and read as authoritative. Missing premium cache rates
 * derive off the PREMIUM input rate exactly as the base ones derive off the
 * base input rate.
 */
function parseTier(model: Record<string, unknown>): RateSet | null {
  const input = model[TIER_FIELDS.input];
  const output = model[TIER_FIELDS.output];
  if (typeof input !== "number" || typeof output !== "number") return null;

  const cacheCreation = model[TIER_FIELDS.cacheCreation];
  const cacheRead = model[TIER_FIELDS.cacheRead];
  const cacheCreationCost = typeof cacheCreation === "number" ? cacheCreation : input * 1.25;
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreationCostPerToken: cacheCreationCost,
    cacheCreation1hCostPerToken: resolveCache1hRate(
      model[TIER_FIELDS.cacheCreation1hAbove200k],
      input,
      cacheCreationCost,
    ),
    cacheReadCostPerToken: typeof cacheRead === "number" ? cacheRead : input * 0.1,
  };
}

export function parseLitellmPricing(data: Record<string, unknown>): PricingTable {
  const table: PricingTable = {};

  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("claude-") || typeof value !== "object" || !value) continue;
    const model = value as Record<string, unknown>;

    const inputCost = model["input_cost_per_token"];
    const outputCost = model["output_cost_per_token"];
    if (typeof inputCost !== "number" || typeof outputCost !== "number") continue;

    const cacheCreationCost =
      typeof model["cache_creation_input_token_cost"] === "number"
        ? model["cache_creation_input_token_cost"]
        : inputCost * 1.25;

    const pricing: ModelPricing = {
      inputCostPerToken: inputCost,
      outputCostPerToken: outputCost,
      cacheCreationCostPerToken: cacheCreationCost,
      cacheCreation1hCostPerToken: resolveCache1hRate(
        model[CACHE_1H_FIELD],
        inputCost,
        cacheCreationCost,
      ),
      cacheReadCostPerToken:
        typeof model["cache_read_input_token_cost"] === "number"
          ? model["cache_read_input_token_cost"]
          : inputCost * 0.1,
    };

    const tier = parseTier(model);
    if (tier) pricing.above200k = tier;

    // Bounds before storage, so an absurd or zero price never reaches the
    // cache, the bar, or the regenerated snapshot (#91). Per entry: one
    // poisoned model must not discard the two dozen good ones — and one
    // poisoned TIER must not discard its model (#103).
    const sane = sanitiseModelPricing(pricing);
    if (!sane) continue;

    // Store with the raw key (e.g. "claude/claude-sonnet-4-20250514" and also the model id)
    const modelId = key.includes("/") ? key.split("/").pop()! : key;
    table[modelId] = sane;
    if (key !== modelId) table[key] = sane;
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
    const response = await fetch(getPricingUrl(), { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const pricing = anchorToSnapshot(parseLitellmPricing(data));
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
