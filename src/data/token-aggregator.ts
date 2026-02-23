import type { JsonlEntry } from "./jsonl-reader.js";
import type { TokenMetrics, AggregatedMetrics } from "../types/token-metrics.js";

function emptyMetrics(): TokenMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addUsage(target: TokenMetrics, entry: JsonlEntry): void {
  if (!entry.usage) return;
  target.inputTokens += entry.usage.input_tokens ?? 0;
  target.outputTokens += entry.usage.output_tokens ?? 0;
  target.cacheCreationTokens += entry.usage.cache_creation_input_tokens ?? 0;
  target.cacheReadTokens += entry.usage.cache_read_input_tokens ?? 0;
}

export function aggregateTokens(
  sessionEntries: JsonlEntry[],
  todayEntries: JsonlEntry[],
): AggregatedMetrics {
  const byModel = new Map<string, TokenMetrics>();
  const session = emptyMetrics();
  const today = emptyMetrics();

  for (const entry of sessionEntries) {
    if (!entry.usage) continue;
    addUsage(session, entry);

    if (entry.model) {
      let model = byModel.get(entry.model);
      if (!model) {
        model = emptyMetrics();
        byModel.set(entry.model, model);
      }
      addUsage(model, entry);
    }
  }

  for (const entry of todayEntries) {
    if (!entry.usage) continue;
    addUsage(today, entry);
  }

  return { byModel, session, today };
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
