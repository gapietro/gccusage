import type { StatusJson } from "../types/status-json.js";
import type { Settings } from "../config/schema.js";
import type { RenderContext } from "../types/render-context.js";
import { findSessionJsonlFiles, findTodayJsonlFiles } from "../utils/paths.js";
import { parseJsonlFile, filterTodayEntries } from "./jsonl-reader.js";
import { aggregateTokens, getFirstTimestamp } from "./token-aggregator.js";
import { detectBlock } from "./block-tracker.js";
import { fetchPricing } from "./pricing-fetcher.js";
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
  // Read JSONL files
  const sessionFiles = findSessionJsonlFiles(stdin.session_id);
  const todayFiles = findTodayJsonlFiles();

  const sessionEntries = sessionFiles.flatMap(parseJsonlFile);
  const todayEntries = filterTodayEntries(todayFiles.flatMap(parseJsonlFile));

  // Aggregate tokens
  const metrics = aggregateTokens(sessionEntries, todayEntries);

  // Get pricing
  const pricing = await fetchPricing(settings.cache?.pricingTtlMs ?? 86400000);

  // Calculate costs
  const costByModel = calculateCostByModel(metrics.byModel, pricing);
  const calculatedSessionCost = calculateTotalCost(costByModel);
  const todayCostByModel = calculateCostByModel(
    aggregateTokens(todayEntries, []).byModel,
    pricing,
  );
  const calculatedTodayCost = calculateTotalCost(todayCostByModel);

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

  // Today's cost: JSONL-calculated when the user forces calculated costs,
  // otherwise our per-session daily tracker. In forced-calculated mode the
  // tracked total is never displayed, so we don't touch the store at all —
  // persisting there would only dirty state nobody reads and add per-session
  // costs on a different scale to the store's own total (issue #32). The
  // tracker is told which source fed it so a source switch isn't read as a
  // restart.
  const todayCostUsd =
    settings.costSource === "calculated"
      ? calculatedTodayCost
      : trackDailyCost(stdin.session_id, sessionCostUsd, sessionCostSource);

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
  const jsonlBurnRate = calculateBurnRate(metrics.session, sessionStartTime, pricing, modelId);
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
