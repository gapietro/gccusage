import type { JsonlEntry } from "./jsonl-reader.js";
import type { TokenCounts, TokenMetrics, AggregatedMetrics } from "../types/token-metrics.js";
import { PREMIUM_PROMPT_THRESHOLD } from "./pricing-tiers.js";

function emptyCounts(): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
  };
}

function emptyMetrics(): TokenMetrics {
  return { ...emptyCounts(), premium: emptyCounts() };
}

/**
 * What Anthropic bills the tier on: the size of THIS request's prompt, cached
 * tokens included. One JsonlEntry is one API request — `parseJsonlContent`
 * already merges the lines sharing a `message.id` — which is why the split
 * belongs here and not in the cost calculator, where only session sums remain.
 */
function promptTokens(usage: NonNullable<JsonlEntry["usage"]>): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function addCounts(target: TokenCounts, usage: NonNullable<JsonlEntry["usage"]>): void {
  target.inputTokens += usage.input_tokens ?? 0;
  target.outputTokens += usage.output_tokens ?? 0;
  target.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  target.cacheCreation1hTokens += usage.cache_creation_1h_input_tokens ?? 0;
  target.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
}

function addUsage(target: TokenMetrics, entry: JsonlEntry): void {
  if (!entry.usage) return;
  addCounts(target, entry.usage);

  // Output follows the prompt's tier: the feed prices output at the premium
  // rate for a request whose prompt crossed the line.
  if (promptTokens(entry.usage) > PREMIUM_PROMPT_THRESHOLD) {
    target.premium ??= emptyCounts();
    addCounts(target.premium, entry.usage);
  }
}

export function aggregateTokens(entries: JsonlEntry[]): AggregatedMetrics {
  const byModel = new Map<string, TokenMetrics>();
  const totals = emptyMetrics();

  for (const entry of entries) {
    if (!entry.usage) continue;
    addUsage(totals, entry);

    if (entry.model) {
      let model = byModel.get(entry.model);
      if (!model) {
        model = emptyMetrics();
        byModel.set(entry.model, model);
      }
      addUsage(model, entry);
    }
  }

  return { byModel, totals };
}

export function getFirstTimestamp(entries: JsonlEntry[]): number | null {
  for (const entry of entries) {
    if (entry.timestamp) {
      const ts = new Date(entry.timestamp).getTime();
      if (!isNaN(ts)) return ts;
    }
  }
  return null;
}
