import type { ModelPricing, PricingTable, RateSet } from "../types/pricing.js";
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

/**
 * Bounds a whole entry, tier included. A failing TIER strips the tier and
 * keeps the model; a failing BASE drops the model, as before. The asymmetry
 * is deliberate: this runs on cache reads as well as on fetches, and losing a
 * model over a bad premium would regress the per-entry posture of #92. A
 * model without a tier prices at standard rates and is flagged approximate.
 */
export function sanitiseModelPricing(value: unknown): ModelPricing | null {
  if (!isSaneModelPricing(value)) return null;
  const pricing = value as ModelPricing;
  if (pricing.above200k === undefined) return pricing;
  if (isSaneTier(pricing.above200k, pricing)) return pricing;

  const { above200k: _rejected, ...withoutTier } = pricing;
  return withoutTier;
}

/**
 * A premium rate below its standard counterpart is not a price, it is a
 * corrupted or poisoned record — the tier exists to charge MORE. Bounds alone
 * would admit it.
 */
function isSaneTier(tier: unknown, base: RateSet): boolean {
  if (!isSaneModelPricing(tier)) return false;
  const rates = tier as RateSet;
  return COST_KEYS.every((key) => rates[key] >= base[key]);
}

/**
 * Drop the entries that fail bounds, keep the rest. Never all-or-nothing —
 * and per-entry itself isn't all-or-nothing: `sanitiseModelPricing` strips a
 * failing tier rather than dropping its model, so a table read here can lose
 * an `above200k` block while keeping the entry it belonged to.
 */
export function sanitisePricingTable(table: Record<string, unknown>): PricingTable {
  const out: PricingTable = {};
  for (const [key, value] of Object.entries(table)) {
    const pricing = sanitiseModelPricing(value);
    if (pricing) out[key] = pricing;
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
    if (
      COST_KEYS.every((k) => withinDeviation(value[k], known[k])) &&
      tierWithinDeviation(value, known)
    ) {
      out[key] = value;
    }
  }

  return out;
}

/**
 * A zero can only come from the feed stating one; there is no ratio to take.
 * `isSaneModelPricing` permits a zero `cacheCreation`/`cacheRead`/`output`
 * cost, so this branch is reachable — it is not dead code guarding against
 * something `parseLitellmPricing` rules out.
 */
function withinDeviation(fetched: number, known: number): boolean {
  if (known === 0) return fetched === 0;
  const ratio = fetched / known;
  return ratio >= 1 / MAX_SNAPSHOT_DEVIATION && ratio <= MAX_SNAPSHOT_DEVIATION;
}

/**
 * A tier the snapshot has no counterpart for passes on bounds alone, exactly
 * as a model absent from the snapshot does. That is the path by which a
 * newly published tier reaches users — blocking it would defeat the point of
 * consuming the feed.
 *
 * Unlike `sanitiseModelPricing`, a drifted tier here drops the WHOLE entry
 * rather than stripping the tier and keeping the rest. That is not the same
 * bug in a different place: `sanitiseModelPricing` has nothing behind it, so
 * dropping the model would leave it unpriced. `anchorToSnapshot` has the
 * snapshot behind it — a dropped entry falls through the fallback merge in
 * pricing-fetcher to `known`'s base AND tier together, a record that is
 * internally coherent. Stripping instead would produce a hybrid — live base,
 * no tier at all, since the merge replaces whole entries rather than filling
 * in the missing piece from the snapshot — and would silently cost premium
 * tokens at standard rates. A tier that moved >10x while its base held still
 * is corruption of that record; distrust the whole thing.
 *
 * The one-sided pass is also reachable from the OTHER direction on purpose:
 * `refreshPricing` runs `parseLitellmPricing` (which calls
 * `sanitiseModelPricing`) before this anchor, so a poisoned tier is already
 * stripped by the time it gets here — it arrives one-sided (fetched has no
 * tier, snapshot does) and passes. That is not a bug to close; it is the
 * strip-don't-drop rule from `sanitiseModelPricing` carried through. The
 * model still prices at standard rates, gets flagged approximated, and the
 * under-report is bounded — the alternative (dropping the whole entry here
 * too) would just re-litigate a decision already made one function up.
 */
function tierWithinDeviation(fetched: ModelPricing, known: ModelPricing): boolean {
  if (!fetched.above200k || !known.above200k) return true;
  const f = fetched.above200k;
  const k = known.above200k;
  return COST_KEYS.every((key) => withinDeviation(f[key], k[key]));
}
