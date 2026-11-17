import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { findSessionJsonlFiles, getCacheDir, shardKey } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";
import type { AggregatedMetrics } from "../types/token-metrics.js";
import {
  FileAggregateSchema,
  persistableAggregates,
  refreshFileAggregates,
  sumAggregates,
  type FileAggregate,
  type FileStat,
} from "./file-aggregate.js";

/**
 * Everything the render derives from the session's transcripts. These were
 * computed from the raw entries of every session file on every uncached
 * render; they are now summed from cached per-file aggregates.
 */
export interface SessionAggregate {
  metrics: AggregatedMetrics;
  /** The session's first timestamp, or null when no file carries one. */
  sessionStartTime: number | null;
  /** Prompts the user typed (`countHumanTurns`). */
  turnCount: number;
}

const SessionAggregateCacheSchema = v.object({
  files: v.record(v.string(), FileAggregateSchema),
});

// A session's cache untouched this long is another session's leftover.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function cacheDir(): string {
  return path.join(getCacheDir(), "session-aggregates");
}

/**
 * One file per session, keyed like the daily store's shards. A single shared
 * file would make two live sessions evict each other's aggregates on every
 * write, which is the full re-parse this cache exists to avoid.
 */
function cachePath(sessionId: string): string {
  return path.join(cacheDir(), `${shardKey(sessionId)}.json`);
}

/**
 * Delete other sessions' caches untouched for a week. Run only when this
 * session's cache is created, so it costs one readdir per new session, not
 * per render. Judged on the file's mtime, which every write updates.
 */
function sweepStale(now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir());
  } catch {
    return;
  }
  for (const name of names) {
    const filePath = path.join(cacheDir(), name);
    try {
      if (now - fs.statSync(filePath).mtimeMs > STALE_MS) fs.unlinkSync(filePath);
    } catch {
      // Raced with another sweep, or unreadable: leave it.
    }
  }
}

function statAll(paths: string[]): FileStat[] {
  const stats: FileStat[] = [];
  for (const filePath of paths) {
    try {
      const s = fs.statSync(filePath);
      stats.push({ path: filePath, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // Gone since the walk listed it: nothing to read.
    }
  }
  return stats;
}

/**
 * This session's token usage, start time and turn count, from every session
 * transcript (main and subagents, COR-007), with each file's aggregate
 * cached on (path, mtimeMs, size).
 *
 * A finished subagent transcript never changes, so on a steady render only
 * the live files are re-parsed. Before this cache, reading subagent
 * transcripts cost about +570 ms per uncached render on the developer's
 * largest session (177 agent files, 213 MB), because every file was
 * re-parsed every time (PR #156 review).
 */
export function getSessionAggregate(sessionId: string | undefined): SessionAggregate {
  const files = statAll(findSessionJsonlFiles(sessionId));

  let previous: Record<string, FileAggregate> = {};
  if (sessionId && files.length > 0) {
    const cached = readJsonValidated(cachePath(sessionId), SessionAggregateCacheSchema);
    if (cached) previous = cached.files;
    else sweepStale(Date.now());
  }

  const next = refreshFileAggregates(files, previous, parseJsonlFile);

  if (sessionId && files.length > 0 && next.changed) {
    try {
      writeJsonAtomic(cachePath(sessionId), { files: persistableAggregates(next.files) });
    } catch {
      // The next render re-parses; a cache that cannot be written costs
      // speed, never correctness.
    }
  }

  // In listing order, which puts the main transcript first: a session starts
  // there, and `getFirstTimestamp` took the first timestamped entry.
  const ordered = files.map((f) => next.files[f.path]!);
  let sessionStartTime: number | null = null;
  for (const aggregate of ordered) {
    if (aggregate.firstTimestamp !== null) {
      sessionStartTime = aggregate.firstTimestamp;
      break;
    }
  }

  return {
    metrics: sumAggregates(ordered),
    sessionStartTime,
    turnCount: ordered.reduce((sum, a) => sum + a.humanTurns, 0),
  };
}
