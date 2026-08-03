import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir, findTodayJsonlFileStats } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { parseJsonlFile, filterTodayEntries } from "../data/jsonl-reader.js";
import { aggregateTokens } from "../data/token-aggregator.js";
import type { TokenMetrics } from "../types/token-metrics.js";

const TokenMetricsSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheCreationTokens: v.number(),
  cacheReadTokens: v.number(),
});

/**
 * `byModel` is entries rather than an object because a Map does not survive
 * JSON; `totals` is stored alongside it because entries carrying usage but no
 * `model` count toward the totals and toward no bucket, so the totals cannot
 * be reconstructed by summing `byModel`.
 */
const FileAggregateSchema = v.object({
  mtimeMs: v.number(),
  size: v.number(),
  byModel: v.array(v.tuple([v.string(), TokenMetricsSchema])),
  totals: TokenMetricsSchema,
});

const TodayAggregateCacheSchema = v.object({
  date: v.string(),
  files: v.record(v.string(), FileAggregateSchema),
});

type FileAggregate = v.InferOutput<typeof FileAggregateSchema>;

export interface TodayAggregate {
  byModel: Map<string, TokenMetrics>;
  totals: TokenMetrics;
  fileCount: number;
}

function cachePath(): string {
  return path.join(getCacheDir(), "today-aggregates.json");
}

/** Local date, matching how `filterTodayEntries` picks its midnight. */
function localDateKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function emptyMetrics(): TokenMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addInto(target: TokenMetrics, source: TokenMetrics): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
}

/**
 * Today's token usage across every transcript, aggregated per file and cached.
 *
 * A cached per-file aggregate is reused only when the file's `mtimeMs` AND
 * `size` both still match, so the returned figure is always assembled from
 * entries that were verified against the live files during this call. Two
 * statuslines racing on the write can therefore cost one extra re-parse on a
 * later render, but neither can serve a wrong total — the same no-lock posture
 * as the daily cost store.
 *
 * Whole files are re-parsed when they change, rather than resuming from a byte
 * offset: `parseJsonlContent` merges lines sharing a `message.id`, so a group
 * straddling an offset boundary would need that map carried across renders.
 * The only file that changes mid-day is the active transcript, and re-parsing
 * it whole is still flat with respect to the day's total volume (#94).
 */
export function getTodayAggregate(now: Date = new Date()): TodayAggregate {
  const files = findTodayJsonlFileStats();
  const date = localDateKey(now);

  const cached = readJsonValidated(cachePath(), TodayAggregateCacheSchema);
  // A different date discards everything: that is the midnight reset.
  const previous = cached && cached.date === date ? cached.files : {};

  const next: Record<string, FileAggregate> = {};
  // A file that dropped out of today's window leaves the counts unequal; one
  // swapped for another is caught by the added file missing from `previous`.
  let changed = Object.keys(previous).length !== files.length;

  for (const file of files) {
    const hit = previous[file.path];
    if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) {
      next[file.path] = hit;
      continue;
    }

    const entries = filterTodayEntries(parseJsonlFile(file.path), now);
    const aggregate = aggregateTokens(entries);
    next[file.path] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      byModel: [...aggregate.byModel],
      totals: aggregate.totals,
    };
    changed = true;
  }

  if (changed) {
    try {
      writeJsonAtomic(cachePath(), { date, files: next });
    } catch {
      // The next render recomputes; a cache that cannot be written costs
      // speed, never correctness.
    }
  }

  const byModel = new Map<string, TokenMetrics>();
  const totals = emptyMetrics();
  for (const aggregate of Object.values(next)) {
    addInto(totals, aggregate.totals);
    for (const [model, metrics] of aggregate.byModel) {
      let bucket = byModel.get(model);
      if (!bucket) {
        bucket = emptyMetrics();
        byModel.set(model, bucket);
      }
      addInto(bucket, metrics);
    }
  }

  return { byModel, totals, fileCount: files.length };
}
