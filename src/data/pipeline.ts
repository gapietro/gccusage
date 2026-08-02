import type { StatusJson } from "../types/status-json.js";
import type { Settings } from "../config/schema.js";
import type { RenderContext } from "../types/render-context.js";
import { findSessionJsonlFiles, findTodayJsonlFiles } from "../utils/paths.js";
import { parseJsonlFile, filterTodayEntries } from "./jsonl-reader.js";
import { aggregateTokens, getFirstTimestamp } from "./token-aggregator.js";
import { detectBlock } from "./block-tracker.js";
import { getPricingForRender } from "./pricing-fetcher.js";
import { maybeSpawnPricingRefresh } from "./pricing-refresh.js";
import {
  calculateCostByModel,
  calculateTotalCost,
  calculateBurnRate,
} from "./cost-calculator.js";
import { getTerminalWidth } from "../utils/terminal.js";
import { trackDailyCost, type CostSource } from "./daily-cost-tracker.js";
import { trackTurn } from "./turn-tracker.js";
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
  // Read this session's transcript. Today's transcripts are read further down,
  // and only when `costSource` is "calculated" — the sole setting that
  // consumes them (#94).
  const sessionFiles = findSessionJsonlFiles(stdin.session_id);
  const sessionEntries = sessionFiles.flatMap(parseJsonlFile);

  const metrics = aggregateTokens(sessionEntries);

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
      ? calculateCostByModel(
          aggregateTokens(filterTodayEntries(findTodayJsonlFiles().flatMap(parseJsonlFile)))
            .byModel,
          pricing,
        )
      : null;

  // Today's cost: JSONL-calculated when the user forces calculated costs,
  // otherwise our per-session daily tracker. In forced-calculated mode the
  // tracked total is never displayed, so we don't touch the store at all —
  // persisting there would only dirty state nobody reads and add per-session
  // costs on a different scale to the store's own total (issue #32). The
  // tracker is told which source fed it so a source switch isn't read as a
  // restart.
  const todayCostUsd =
    today !== null
      ? calculateTotalCost(today.costs)
      : trackDailyCost(stdin.session_id, sessionCostUsd, sessionCostSource);

  // A missing price can only understate a figure the pricing table produced.
  // The stdin cost and the daily store are unaffected, so marking them would
  // be a false alarm — and a bar that cries uncertain on every render is a
  // bar nobody reads.
  const sessionCostUncertain = sessionCostSource === "calculated" && session.unpriced.length > 0;
  const todayCostUncertain = today !== null && today.unpriced.length > 0;

  // Session timing
  const sessionStartTime = getFirstTimestamp(sessionEntries);

  // Block detection
  const block = detectBlock(sessionStartTime);

  // Burn rate must come from the same cost source as the session total, or the
  // bar shows two cost scales side by side — a stdin-priced rate beside a
  // JSONL-priced total. `sessionCostSource` already encodes both the user's
  // `costSource` setting and the stdin-missing fallback, so reuse it rather
  // than re-deriving the decision. Mixing sources is what produced the
  // today-spend inflation in PR #34.
  const modelId = typeof stdin.model === "string"
    ? stdin.model
    : stdin.model?.id;
  const jsonlBurnRate = calculateBurnRate(metrics.totals, sessionStartTime, pricing, modelId);
  const burnRate =
    sessionCostSource === "stdin" ? (getStdinBurnRate(stdin) ?? jsonlBurnRate) : jsonlBurnRate;

  return {
    stdin,
    metrics,
    block,
    burnRate,
    pricing,
    sessionCostUsd,
    todayCostUsd,
    costByModel,
    unpricedModels: session.unpriced,
    sessionCostUncertain,
    todayCostUncertain,
    sessionStartTime,
    terminalWidth: getTerminalWidth(),
    turnCount: trackTurn(stdin.session_id),
    alerts: {
      sessionWarn: settings.alerts?.sessionWarn ?? 5,
      sessionDanger: settings.alerts?.sessionDanger ?? 15,
      dailyWarn: settings.alerts?.dailyWarn ?? 10,
      dailyDanger: settings.alerts?.dailyDanger ?? 25,
    },
  };
}
