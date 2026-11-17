import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir, findTodayJsonlFileStats } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { localDateKey } from "../utils/local-date.js";
import { parseJsonlFile, filterTodayEntries } from "../data/jsonl-reader.js";
import type { TokenMetrics } from "../types/token-metrics.js";
import {
  FileAggregateSchema,
  persistableAggregates,
  refreshFileAggregates,
  sumAggregates,
} from "./file-aggregate.js";

const TodayAggregateCacheSchema = v.object({
  date: v.string(),
  files: v.record(v.string(), FileAggregateSchema),
});

export interface TodayAggregate {
  byModel: Map<string, TokenMetrics>;
  totals: TokenMetrics;
  fileCount: number;
}

/** Null when there is no cache dir (SEC-004): every file is re-parsed. */
function cachePath(): string | null {
  const dir = getCacheDir();
  return dir === null ? null : path.join(dir, "today-aggregates.json");
}

/**
 * Today's token usage across every transcript, aggregated per file and cached.
 * Reuse and re-parse follow `refreshFileAggregates`: a file is re-parsed only
 * when its `mtimeMs` or `size` changed. The only file that changes mid-day is
 * the active transcript, so re-parsing it whole is still flat with respect to
 * the day's total volume (#94).
 */
export function getTodayAggregate(now: Date = new Date()): TodayAggregate {
  const files = findTodayJsonlFileStats();
  const date = localDateKey(now);

  const target = cachePath();
  const cached = target === null ? null : readJsonValidated(target, TodayAggregateCacheSchema);
  // A different date discards everything: that is the midnight reset.
  const previous = cached && cached.date === date ? cached.files : {};

  const next = refreshFileAggregates(files, previous, (filePath) =>
    filterTodayEntries(parseJsonlFile(filePath), now),
  );

  if (next.changed && target !== null) {
    try {
      writeJsonAtomic(target, { date, files: persistableAggregates(next.files) });
    } catch {
      // The next render recomputes; a cache that cannot be written costs
      // speed, never correctness.
    }
  }

  const { byModel, totals } = sumAggregates(Object.values(next.files));
  return { byModel, totals, fileCount: files.length };
}
