// `Number.prototype.toFixed` stringifies Infinity/-Infinity/NaN rather than
// throwing (`Infinity.toFixed(0)` is the literal text "Infinity"), and a
// non-finite `total_cost_usd` reaches this function straight from stdin —
// there is no schema on that path to reject it. #130 constrained the daily
// cost SHARD's `v.finite()` on read/write, but `trackDailyCost` computes
// `Math.max(0, Infinity - 0)` and returns it in memory before anything ever
// reads that shard, so the shard guard never sees it. "$0.00" is deliberately
// not the fallback here: that would silently claim the cost is known and
// zero, which is false. "$?" matches this repo's existing convention for a
// cost it cannot state confidently — see `sessionCostUncertain` in
// session-cost.ts / today-spend.ts, which append a bare "?" to a real
// computed amount; this is the same marker for the case where there is no
// amount to append it to at all. A closer precedent is
// per-model-breakdown.ts's `${formatModelName(model)}:$?`, which emits the
// identical "$?" for a model with no pricing entry — a related but distinct
// meaning ("no price available" vs "the number was not a number"). The two
// can't collide into "$??": the uncertainty suffix only appends when
// `sessionCostSource === "calculated"` (pipeline.ts), while this guard's
// path is only reachable when the source is "stdin".
export function formatDollars(amount: number): string {
  if (!Number.isFinite(amount)) return "$?";
  if (amount < 0.01) return "$0.00";
  if (amount < 1) return `$${amount.toFixed(2)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(0)}`;
}

// Same reasoning as `formatDollars` above, and the same "?" convention — but
// this guard is NOT made redundant by `StatusJsonSchema` now rejecting
// non-finite numbers (#137). Token counts also arrive from JSONL transcripts
// through `jsonl-reader`, whose own `typeof x === "number"` guards never touch
// that schema. Without it, `(Infinity / 1e6).toFixed(2)` renders "InfinityM".
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "?";
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

// `Math.floor(Infinity)` is `Infinity`, so an unguarded non-finite span
// produced "Infinityhr NaNm" — two broken numbers out of one bad input,
// because the minutes come from `Infinity % 3600`, which is NaN.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}hr ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatModelName(model: string): string {
  // claude-sonnet-4-20250514 -> Sonnet 4
  // claude-opus-4-6-20250219 -> Opus 4.6
  // claude-haiku-4-5-20251001 -> Haiku 4.5
  // claude-haiku-3.5-20241001 -> Haiku 3.5
  const match = model.match(/claude-(\w+)-(\d+)(?:[.-](\d{1,2})(?=-|$))?/);
  if (match) {
    const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
    return `${name} ${version}`;
  }
  return model;
}

/**
 * Spend rate for the status bar. Mirrors formatDollars' thresholds so a rate
 * and a total read consistently beside each other, and drops the cents above
 * $100/hr because bar width is scarcer than that precision is useful.
 */
// Same defect and same fix as `formatDollars` above, in a sibling function
// that does not call it and so does not inherit its guard: `burn-rate`
// renders through this path (`costPerHour = costUsd / elapsedMinutes`), and a
// non-finite `total_cost_usd` produces a non-finite `costPerHour` by the same
// route. Confirmed reachable end-to-end: a stdin payload with
// `total_cost_usd: 1e400` and `total_duration_ms` >= 10s puts `$Infinity/hr`
// on the bar via this function, independently of the `formatDollars` fix.
export function formatCostPerHour(costPerHour: number): string {
  if (!Number.isFinite(costPerHour)) return "$?/hr";
  if (costPerHour < 0.01) return "$0.00/hr";
  if (costPerHour < 100) return `$${costPerHour.toFixed(2)}/hr`;
  return `$${costPerHour.toFixed(0)}/hr`;
}
