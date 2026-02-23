import type { StatusJson } from "../types/status-json.js";
import type { Settings } from "../config/schema.js";
import type { RenderContext } from "../types/render-context.js";
import { findSessionJsonlFiles, findTodayJsonlFiles } from "../utils/paths.js";
import { parseJsonlFile } from "./jsonl-reader.js";
import { aggregateTokens, getFirstTimestamp } from "./token-aggregator.js";
import { detectBlock } from "./block-tracker.js";
import { fetchPricing } from "./pricing-fetcher.js";
import {
  calculateCostByModel,
  calculateTotalCost,
  calculateBurnRate,
} from "./cost-calculator.js";
import { getTerminalWidth } from "../utils/terminal.js";

export async function buildRenderContext(
  stdin: StatusJson,
  settings: Settings,
): Promise<RenderContext> {
  // Read JSONL files
  const sessionFiles = findSessionJsonlFiles(stdin.session_id);
  const todayFiles = findTodayJsonlFiles();

  const sessionEntries = sessionFiles.flatMap(parseJsonlFile);
  const todayEntries = todayFiles.flatMap(parseJsonlFile);

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
  if (settings.costSource === "stdin" && stdinCost !== undefined) {
    sessionCostUsd = stdinCost;
  } else if (settings.costSource === "calculated") {
    sessionCostUsd = calculatedSessionCost;
  } else {
    // auto: prefer stdin if available
    sessionCostUsd = stdinCost ?? calculatedSessionCost;
  }

  // Session timing
  const sessionStartTime = getFirstTimestamp(sessionEntries);

  // Block detection
  const block = detectBlock(sessionStartTime);

  // Burn rate
  const modelId = typeof stdin.model === "string"
    ? stdin.model
    : stdin.model?.id;
  const burnRate = calculateBurnRate(
    metrics.session,
    sessionStartTime,
    pricing,
    modelId,
  );

  return {
    stdin,
    metrics,
    block,
    burnRate,
    pricing,
    sessionCostUsd,
    todayCostUsd: calculatedTodayCost,
    costByModel,
    sessionStartTime,
    terminalWidth: getTerminalWidth(),
  };
}
