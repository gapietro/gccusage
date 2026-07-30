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

  const cw = stdin.context_window;
  if (typeof cw !== "object" || !cw) return null;

  const totalTokens = (cw.total_input_tokens ?? 0) + (cw.total_output_tokens ?? 0);
  if (totalTokens === 0) return null;

  const elapsedMinutes = durationMs / 60000;
  const tokensPerMinute = totalTokens / elapsedMinutes;

  const costUsd = stdin.cost?.total_cost_usd ?? 0;
  const costPerMinute = costUsd / elapsedMinutes;

  return {
    tokensPerMinute,
    costPerHour: costPerMinute * 60,
    costPerMinute,
  };
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

  // Burn rate: prefer stdin data (always available), fall back to JSONL calculation
  const modelId = typeof stdin.model === "string"
    ? stdin.model
    : stdin.model?.id;
  const burnRate = getStdinBurnRate(stdin)
    ?? calculateBurnRate(metrics.session, sessionStartTime, pricing, modelId);

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
