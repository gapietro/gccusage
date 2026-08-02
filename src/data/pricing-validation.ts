import type { ModelPricing, PricingTable } from "../types/pricing.js";
import { FALLBACK_PRICING } from "./fallback-pricing.js";

/**
 * $1000 per million tokens. The live table tops out at 7.5e-5 (Opus output),
 * so this sits ~13x above anything real: it rejects the absurd and never a
 * genuine repricing.
 */
export const MAX_COST_PER_TOKEN = 1e-3;

/**
 * How far a fetched price may drift from the checked-in snapshot before we
 * stop believing it. Anthropic has never moved a price by this factor.
 */
export const MAX_SNAPSHOT_DEVIATION = 10;

const COST_KEYS = [
  "inputCostPerToken",
  "outputCostPerToken",
  "cacheCreationCostPerToken",
  "cacheReadCostPerToken",
] as const;

/**
 * Bounds. Answers "is this a plausible price record?", which is intrinsic to
 * parsing one — so it runs inside `parseLitellmPricing`, and every caller
 * inherits it, including `npm run pricing` when it regenerates the snapshot.
 */
export function isSaneModelPricing(value: unknown): value is ModelPricing {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  for (const key of COST_KEYS) {
    const cost = record[key];
    if (typeof cost !== "number" || !Number.isFinite(cost)) return false;
    if (cost < 0 || cost > MAX_COST_PER_TOKEN) return false;
  }

  // A zero input cost is not a free model — it is a broken record, and it
  // renders a confident $0.00 for a real session exactly as the stale
  // fallback table did (#82).
  return (record["inputCostPerToken"] as number) > 0;
}

/** Drop the entries that fail bounds, keep the rest. Never all-or-nothing. */
export function sanitisePricingTable(table: Record<string, unknown>): PricingTable {
  const out: PricingTable = {};
  for (const [key, value] of Object.entries(table)) {
    if (isSaneModelPricing(value)) out[key] = value;
  }
  return out;
}

/**
 * Integrity anchor. Bounds alone still admit a 13x overcharge, so a fetched
 * price for a model we already ship a snapshot for must land within
 * MAX_SNAPSHOT_DEVIATION of it. A rejected entry falls through to its
 * FALLBACK_PRICING value via the merge in pricing-fetcher, so the degradation
 * is to last-known-good rather than to nothing.
 *
 * Deliberately NOT applied when reading the cache: the anchor is about
 * trusting the feed, cached entries already passed it at write time, and
 * re-running it would silently invalidate a legitimately cached price the day
 * someone regenerates the snapshot after a real price move.
 *
 * Models absent from the snapshot are genuinely new and pass on bounds alone.
 */
export function anchorToSnapshot(
  table: PricingTable,
  snapshot: PricingTable = FALLBACK_PRICING,
): PricingTable {
  const out: PricingTable = {};

  for (const [key, value] of Object.entries(table)) {
    const known = snapshot[key];
    if (!known) {
      out[key] = value;
      continue;
    }
    if (COST_KEYS.every((k) => withinDeviation(value[k], known[k]))) {
      out[key] = value;
    }
  }

  return out;
}

/**
 * A zero in the snapshot means the feed stated zero — `parseLitellmPricing`
 * derives its defaults from the input cost and never produces one. There is no
 * ratio to take, so only zero matches.
 */
function withinDeviation(fetched: number, known: number): boolean {
  if (known === 0) return fetched === 0;
  const ratio = fetched / known;
  return ratio >= 1 / MAX_SNAPSHOT_DEVIATION && ratio <= MAX_SNAPSHOT_DEVIATION;
}
