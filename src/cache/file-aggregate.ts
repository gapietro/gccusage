import * as v from "valibot";
import { finiteNumber } from "../utils/schemas.js";
import type { JsonlEntry } from "../data/jsonl-reader.js";
import { aggregateTokens, countHumanTurns, getFirstTimestamp } from "../data/token-aggregator.js";
import type { AggregatedMetrics, TokenCounts, TokenMetrics } from "../types/token-metrics.js";

/**
 * Per-file transcript aggregates, cached on disk and reused while the file's
 * `mtimeMs` and `size` both still match. Shared by the today aggregate
 * (`today-aggregate-cache.ts`, #94) and the session aggregate
 * (`session-aggregate-cache.ts`, COR-007), which cache different entries of
 * the same files: today's are filtered to today, the session's are not.
 */

// Every count is finite as well as non-negative. `JSON.parse` turns `1e400`
// in a corrupt or hand-edited cache file into `Infinity`, which `v.number()`
// accepts, and one infinite count makes every cost derived from it
// non-finite (#145, COR-006). `finiteNumber()` is the one shared rule for
// that, in `src/utils/schemas.ts`.
//
// A negative count already passed plain v.number() before #103; the tier
// split SUBTRACTS `premium` from these base counts to get the standard
// bucket (see cost-calculator.ts), so a negative here turns "wrong but
// bounded" into an arbitrarily wrong, possibly negative, cost. Rejecting on
// read is not a full fix (it does not enforce premium <= base), but it closes
// off the unbounded case cleanly, and enforcing the cross-field invariant here
// would require a v.custom check that dredges up the wider "which
// decomposition is canonical" question this cache boundary should not have
// to answer.
const count = v.pipe(finiteNumber(), v.minValue(0));

const TokenCountsSchema = v.object({
  inputTokens: count,
  outputTokens: count,
  cacheCreationTokens: count,
  cacheCreation1hTokens: count,
  cacheReadTokens: count,
});

/**
 * `premium` is REQUIRED, so a cache file written before the tier split fails
 * validation and is discarded rather than read as "no premium tokens" — a
 * wrong total for the rest of the day is worse than one re-parse (#103).
 *
 * `cacheCreation1hTokens` is likewise REQUIRED, so a file written before the
 * TTL split fails validation and is discarded rather than read as "no 1-hour
 * tokens" — which would under-cost the rest of the day (#118).
 */
const TokenMetricsSchema = v.object({
  ...TokenCountsSchema.entries,
  premium: TokenCountsSchema,
});

/**
 * `byModel` is entries rather than an object because a Map does not survive
 * JSON; `totals` is stored alongside it because entries carrying usage but no
 * `model` count toward the totals and toward no bucket, so the totals cannot
 * be reconstructed by summing `byModel`.
 *
 * `firstTimestamp` and `humanTurns` are what the session render derives from
 * a transcript besides its tokens: the session's start and its turn count.
 * They are REQUIRED, so a cache written before they existed is discarded
 * rather than read as "no start, no turns".
 */
export const FileAggregateSchema = v.object({
  mtimeMs: finiteNumber(),
  size: v.pipe(finiteNumber(), v.minValue(0)),
  byModel: v.array(v.tuple([v.string(), TokenMetricsSchema])),
  totals: TokenMetricsSchema,
  firstTimestamp: v.nullable(finiteNumber()),
  humanTurns: v.pipe(finiteNumber(), v.integer(), v.minValue(0)),
});

export type FileAggregate = v.InferOutput<typeof FileAggregateSchema>;

/** A transcript's identity for reuse: the stat the walk already performed. */
export interface FileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

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

function addCountsInto(target: TokenCounts, source: TokenCounts): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheCreation1hTokens += source.cacheCreation1hTokens;
  target.cacheReadTokens += source.cacheReadTokens;
}

function addInto(target: TokenMetrics, source: TokenMetrics): void {
  addCountsInto(target, source);
  if (source.premium) {
    target.premium ??= emptyCounts();
    addCountsInto(target.premium, source.premium);
  }
}

function countsFinite(c: TokenCounts): boolean {
  return (
    Number.isFinite(c.inputTokens) &&
    Number.isFinite(c.outputTokens) &&
    Number.isFinite(c.cacheCreationTokens) &&
    Number.isFinite(c.cacheCreation1hTokens) &&
    Number.isFinite(c.cacheReadTokens)
  );
}

/**
 * Whether a per-file aggregate survives a round-trip through the cache file.
 * Ingestion rejects non-finite counts, but finite ones can still sum past
 * Number.MAX_VALUE. `JSON.stringify` writes that as `null`, which fails the
 * schema and discards every file's cached aggregate, so one such file would
 * force every file to be re-parsed on every render.
 */
function aggregateFinite(a: FileAggregate): boolean {
  const metricsFinite = (m: TokenMetrics) =>
    countsFinite(m) && (m.premium === undefined || countsFinite(m.premium));
  return metricsFinite(a.totals) && a.byModel.every(([, m]) => metricsFinite(m));
}

/**
 * `TokenMetrics.premium` stays optional in memory (other call sites build
 * `TokenMetrics` by hand), but the on-disk schema requires it. `aggregateTokens`
 * always populates it, so this is just bridging the wider in-memory type to the
 * stricter persisted one — not a silent default for genuinely-missing data.
 */
function withRequiredPremium(metrics: TokenMetrics): TokenMetrics & { premium: TokenCounts } {
  return { ...metrics, premium: metrics.premium ?? emptyCounts() };
}

function aggregateEntries(file: FileStat, entries: JsonlEntry[]): FileAggregate {
  const aggregate = aggregateTokens(entries);
  return {
    mtimeMs: file.mtimeMs,
    size: file.size,
    byModel: [...aggregate.byModel].map(
      ([model, metrics]) => [model, withRequiredPremium(metrics)] as const,
    ),
    totals: withRequiredPremium(aggregate.totals),
    firstTimestamp: getFirstTimestamp(entries),
    humanTurns: countHumanTurns(entries),
  };
}

export interface RefreshedAggregates {
  /** One aggregate per file in `files`, keyed by path. */
  files: Record<string, FileAggregate>;
  /** Whether `files` differs from `previous`, so the cache needs writing. */
  changed: boolean;
}

/**
 * Reuse each file's cached aggregate while its `mtimeMs` AND `size` both still
 * match, and re-parse the rest with `readEntries`. The result is always
 * assembled from aggregates verified against the live files during this
 * call, so two processes racing on the cache write can cost one extra
 * re-parse on a later render, never a wrong total.
 *
 * Whole files are re-parsed when they change, rather than resumed from a byte
 * offset: `parseJsonlContent` merges lines sharing a `message.id`, so a group
 * straddling an offset boundary would need that map carried across renders.
 */
export function refreshFileAggregates(
  files: FileStat[],
  previous: Record<string, FileAggregate>,
  readEntries: (filePath: string) => JsonlEntry[],
): RefreshedAggregates {
  const next: Record<string, FileAggregate> = {};
  // A file that dropped out leaves the counts unequal; one swapped for
  // another is caught by the added file missing from `previous`.
  let changed = Object.keys(previous).length !== files.length;

  for (const file of files) {
    const hit = Object.hasOwn(previous, file.path) ? previous[file.path] : undefined;
    if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) {
      next[file.path] = hit;
      continue;
    }
    next[file.path] = aggregateEntries(file, readEntries(file.path));
    changed = true;
  }

  return { files: next, changed };
}

/**
 * The aggregates that can be written. An overflowing file is used for this
 * render but not cached; it is re-parsed next time while every other file is
 * still a cache hit.
 */
export function persistableAggregates(
  files: Record<string, FileAggregate>,
): Record<string, FileAggregate> {
  return Object.fromEntries(Object.entries(files).filter(([, a]) => aggregateFinite(a)));
}

/** Sum per-file aggregates into one session's or one day's metrics. */
export function sumAggregates(aggregates: Iterable<FileAggregate>): AggregatedMetrics {
  const byModel = new Map<string, TokenMetrics>();
  const totals = emptyMetrics();
  for (const aggregate of aggregates) {
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
  return { byModel, totals };
}
