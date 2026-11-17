import type { StatusJson } from "../types/status-json.js";
import type { Settings } from "../config/schema.js";
import type { RenderContext } from "../types/render-context.js";
import { getSessionAggregate } from "../cache/session-aggregate-cache.js";
import { detectBlock } from "./block-tracker.js";
import { getPricingForRender } from "./pricing-fetcher.js";
import { maybeSpawnPricingRefresh } from "./pricing-refresh.js";
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
import {
  calculateCostByModel,
  calculateTotalCost,
  calculateBurnRate,
} from "./cost-calculator.js";
import { getTerminalWidth } from "../utils/terminal.js";
import { recordDailyCost, type CostSource } from "./daily-cost-tracker.js";
import type { BurnRate } from "../types/burn-rate.js";

function getStdinBurnRate(stdin: StatusJson): BurnRate | null {
  const durationMs = stdin.cost?.total_duration_ms;
  if (!durationMs || durationMs < 10000) return null;

  const costUsd = stdin.cost?.total_cost_usd;
  if (costUsd === undefined) return null;

  const elapsedMinutes = durationMs / 60000;
  const costPerMinute = costUsd / elapsedMinutes;

  return { costPerHour: costPerMinute * 60, costPerMinute };
}

export async function buildRenderContext(
  stdin: StatusJson,
  settings: Settings,
): Promise<RenderContext> {
  // Taken before any transcript parsing: the daily store estimates this
  // process's start as `now - cost.total_duration_ms`, and every millisecond
  // between Claude Code building the payload and this line is error in that
  // estimate (COR-005). Parsing a large transcript first added seconds.
  const renderStartedAt = Date.now();

  // Read this session's transcripts: the main one and its subagents'
  // (COR-007), each file's aggregate cached so only live files are
  // re-parsed. Today's transcripts are read further down, and only when
  // `costSource` is "calculated" — the sole setting that consumes them (#94).
  const sessionAggregate = getSessionAggregate(stdin.session_id);
  const metrics = sessionAggregate.metrics;

  // Get pricing — cache-or-fallback only. Refreshing happens in a detached
  // child so the bar never waits on the network (#84).
  const { pricing, stale } = getPricingForRender(settings.cache?.pricingTtlMs ?? 86400000);
  maybeSpawnPricingRefresh(stale);

  // Calculate costs
  const session = calculateCostByModel(metrics.byModel, pricing);
  const costByModel = session.costs;
  const calculatedSessionCost = calculateTotalCost(costByModel);

  // Determine cost source (cost.total_cost_usd works for both formats)
  const stdinCost = stdin.cost?.total_cost_usd;
  let sessionCostUsd: number;
  let sessionCostSource: CostSource;
  if (settings.costSource === "calculated" || stdinCost === undefined) {
    // "calculated", or "stdin"/"auto" falling back when stdin has no cost
    sessionCostUsd = calculatedSessionCost;
    sessionCostSource = "calculated";
  } else {
    sessionCostUsd = stdinCost;
    sessionCostSource = "stdin";
  }

  // Today's transcripts are read only for the one setting that displays a
  // JSONL-derived today figure. Everywhere else `todayCostUsd` comes from the
  // daily store, and reading them was 33 MB of work per cache miss whose
  // result was discarded (#94).
  //
  // The condition is the SETTING, not `sessionCostSource`: "auto" with no
  // stdin cost resolves the session source to "calculated" while today's spend
  // still comes from the store, so gating on the resolved source would put the
  // read back.
  const today =
    settings.costSource === "calculated"
      ? calculateCostByModel(getTodayAggregate().byModel, pricing)
      : null;

  // A missing price can only understate a figure the pricing table produced,
  // and so can a missing premium tier. The stdin cost is unaffected, so
  // marking it would be a false alarm — and a bar that cries uncertain on
  // every render is a bar nobody reads.
  const sessionCostUncertain =
    sessionCostSource === "calculated" &&
    (session.unpriced.length > 0 || session.approximated.length > 0);

  // Today's cost: JSONL-calculated when the user forces calculated costs,
  // otherwise our per-session daily tracker. In forced-calculated mode the
  // tracked total is never displayed, so we don't touch the store at all —
  // persisting there would only dirty state nobody reads and add per-session
  // costs on a different scale to the store's own total (issue #32). The
  // tracker is told which source fed it so a source switch isn't read as a
  // restart.
  //
  // In store mode the tracker owns Today's uncertainty (COR-009): it stores
  // each session's flag, so a lower-bound figure is marked on every session's
  // bar, and it alone knows whether this render's cost was recorded.
  // Re-deriving that here missed the tracker's second skip path.
  const stored =
    today === null
      ? recordDailyCost(
          {
            sessionId: stdin.session_id,
            costUsd: sessionCostUsd,
            source: sessionCostSource,
            processStart: processStartOf(stdin, renderStartedAt),
            uncertain: sessionCostUncertain,
          },
          new Date(renderStartedAt),
        )
      : null;
  const todayCostUsd = stored ? stored.totalUsd : calculateTotalCost(today!.costs);
  const todayCostUncertain = stored
    ? stored.uncertain
    : today!.unpriced.length > 0 || today!.approximated.length > 0;

  // Session timing
  const sessionStartTime = sessionAggregate.sessionStartTime;

  // Block detection
  const block = detectBlock(sessionStartTime);

  // Burn rate must come from the same cost source as the session total, or the
  // bar shows two cost scales side by side — a stdin-priced rate beside a
  // JSONL-priced total. `sessionCostSource` already encodes both the user's
  // `costSource` setting and the stdin-missing fallback, so reuse it rather
  // than re-deriving the decision. Mixing sources is what produced the
  // today-spend inflation in PR #34.
  //
  // The calculated rate divides the per-model session cost, the same figure
  // as the calculated session total, so it no longer depends on the stdin
  // model (COR-008).
  const jsonlBurnRate = calculateBurnRate(session, sessionStartTime);
  const stdinBurnRate = sessionCostSource === "stdin" ? getStdinBurnRate(stdin) : null;
  const burnRate = stdinBurnRate ?? jsonlBurnRate;
  // Flags the producer actually used, not the session's cost source: when the
  // total is stdin's but stdin reports no duration, or under 10s of it, the
  // rate falls back to the calculated one, while `sessionCostUncertain` is
  // false because the TOTAL is stdin's. The stdin rate is never uncertain.
  const burnRateUncertain =
    burnRate !== null &&
    stdinBurnRate === null &&
    (session.unpriced.length > 0 || session.approximated.length > 0);

  return {
    stdin,
    metrics,
    block,
    burnRate,
    burnRateUncertain,
    pricing,
    sessionCostUsd,
    todayCostUsd,
    costByModel,
    unpricedModels: session.unpriced,
    approximatedModels: session.approximated,
    sessionCostUncertain,
    todayCostUncertain,
    sessionStartTime,
    terminalWidth: getTerminalWidth(),
    // Derived from the transcript on every render rather than accumulated in a
    // cache file. The old counter incremented once per statusline-cache miss,
    // which is neither a turn nor a render (#129). On a cache hit nothing here
    // runs at all — the previously rendered string is replayed — so the point
    // is not that the count is recomputed then, but that it is no longer
    // perturbed by how often the cache missed. Costs nothing: it is counted
    // per file alongside the tokens, and cached with them.
    turnCount: sessionAggregate.turnCount,
    alerts: {
      sessionWarn: settings.alerts?.sessionWarn ?? 5,
      sessionDanger: settings.alerts?.sessionDanger ?? 15,
      dailyWarn: settings.alerts?.dailyWarn ?? 10,
      dailyDanger: settings.alerts?.dailyDanger ?? 25,
    },
  };
}

/**
 * When this Claude Code process started, from the payload: `now -
 * cost.total_duration_ms`. Stable for the life of a process (a resumed process
 * continues its restored clock), and different for two processes sharing a
 * session_id, which is what lets the daily store keep them apart (COR-005).
 *
 * `undefined` for anything that is not a plausible start: a missing or
 * negative duration, one longer than the clock itself, or a result that is
 * not a safe integer — `ShardSchema` reads `processStart` back with
 * `v.safeInteger()`, so an unsafe one was written, dropped on read, and grew
 * a new entry on every render.
 */
export function processStartOf(stdin: StatusJson, now: number): number | undefined {
  const duration = stdin.cost?.total_duration_ms;
  if (duration === undefined || !Number.isFinite(duration) || duration < 0 || duration > now) {
    return undefined;
  }
  const start = Math.round(now - duration);
  return Number.isSafeInteger(start) ? start : undefined;
}
