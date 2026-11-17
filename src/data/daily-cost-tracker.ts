import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir, shardKey } from "../utils/paths.js";
import { writeJsonAtomic, readJsonValidated } from "../utils/atomic-json.js";
import { localDateKey } from "../utils/local-date.js";

export type CostSource = "stdin" | "calculated";

const CostSourceSchema = v.picklist(["stdin", "calculated"]);

/**
 * The shard schema replaces four hand-rolled `typeof` checks scattered through
 * this file (#92). `v.fallback` preserves each tolerance exactly: a shard
 * written before `baselineUsd` existed reads as 0, and one with no `updatedAt`
 * reads as 0 and is therefore pruned as stale, which is what the old
 * `entry.updatedAt ?? 0` did.
 *
 * `v.object` strips unknown keys, and the parsed result is later written back
 * verbatim (see `writeJsonAtomic(shardPath(...), entry)` below). A future
 * version's extra field therefore survives a round-trip through a newer
 * binary but is silently dropped by an older one reading the same shard. No
 * impact today — every writer emits exactly these six fields — but adding a
 * seventh here without updating every reader will lose it quietly rather than
 * loudly.
 */
const ShardSchema = v.object({
  sessionId: v.string(),
  date: v.string(), // local date the baseline belongs to
  // `v.finite()`, not bare `v.number()`: `JSON.parse("1e400")` is `Infinity`
  // and `v.number()` accepts it. `formatDollars` itself is now guarded
  // (#131) and renders a non-finite amount as "$?" rather than the literal
  // text "$Infinity", so this constraint is no longer the only thing
  // standing between a garbage shard value and the rendered bar. It still
  // earns its place as defence in depth at the storage boundary: without it,
  // an infinite `costUsd` would flow into `Math.max(0, costUsd -
  // baselineUsd)` below and corrupt that arithmetic, not just the string a
  // formatter later produces from it.
  costUsd: v.pipe(v.number(), v.finite()), // latest cumulative session cost
  baselineUsd: v.fallback(v.pipe(v.number(), v.finite()), 0), // cumulative cost at the start of `date`
  // Absent in legacy files, and an unrecognised value is treated the same way.
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  // A second, independent failure from the same parse: `now - Infinity` is
  // `-Infinity`, which is always less than STALE_SESSION_MS, making the shard
  // unpruneable forever. `v.finite()` alone is not enough here, unlike
  // `costUsd`/`baselineUsd` above — 1e300 is finite, so it would pass the
  // pipe, and `now - 1e300` is just as never-stale as `now - Infinity`.
  // `updatedAt` is always an integer millisecond stamp from `Date.now()` /
  // `getTime()`, so it gets the stricter `v.safeInteger()`, the same
  // constraint the deleted `TurnDataSchema` used for its own timestamp. The
  // fallback to 0 makes a rejected value read as infinitely stale instead, so
  // it is pruned on the next sweep (#130).
  updatedAt: v.fallback(v.pipe(v.number(), v.safeInteger()), 0),
  // The Claude Code process this entry belongs to (COR-005), as its start
  // time: `now - cost.total_duration_ms`. Absent for a payload without a
  // duration and for every shard written before this field existed; those
  // stay one entry per session, exactly as before.
  processStart: v.fallback(v.optional(v.pipe(v.number(), v.safeInteger())), undefined),
  // The cost was a lower bound (unpriced or approximated models), or this
  // session's latest cost could not be recorded and `costUsd` is stale
  // (COR-009). Stored so every session's Today: carries the marker, not only
  // the bar of the session that knew.
  uncertain: v.fallback(v.boolean(), false),
});

type SessionCostEntry = v.InferOutput<typeof ShardSchema>;

const LegacyStoreSchema = v.object({
  date: v.fallback(v.optional(v.string()), undefined),
  sessions: v.fallback(v.array(v.unknown()), []),
});

const LegacyEntrySchema = v.object({
  sessionId: v.string(),
  costUsd: v.pipe(v.number(), v.finite()),
  baselineUsd: v.fallback(v.pipe(v.number(), v.finite()), 0),
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  updatedAt: v.fallback(v.optional(v.pipe(v.number(), v.safeInteger())), undefined),
});

const STALE_SESSION_MS = 48 * 3600 * 1000;

function getShardDir(): string {
  return path.join(getCacheDir(), "daily");
}

function getLegacyPath(): string {
  return path.join(getCacheDir(), "daily-costs.json");
}

/**
 * One file per session, so a render only ever writes its own session's data.
 * Concurrent sessions therefore cannot clobber each other's entries — there
 * is no shared read-modify-write left to lose an update.
 */
function shardPath(sessionId: string, processStart?: number): string {
  const suffix = processStart === undefined ? "" : `.p${processStart}`;
  return path.join(getShardDir(), `${shardKey(sessionId)}${suffix}.json`);
}

/**
 * How far apart two computed starts of one process may be. `now -
 * total_duration_ms` is exact in Claude Code, but `now` is taken here after
 * the spawn and the stdin read (before any transcript parse, see
 * pipeline.ts), so each estimate is late by roughly a second. Two processes of
 * one session started closer than this share an entry; resumes of the same
 * saved state in quick succession can (a tmux restore), so it is kept small.
 */
const PROCESS_START_TOLERANCE_MS = 10_000;

/**
 * Claude Code runs the statusline command when its statusline controller
 * starts (2.1.326: `#S()` calls the run method immediately), so a fresh
 * process's first render lands seconds in. A first render further in than
 * this, already carrying spend, is a process whose cost was restored
 * (`--resume`, including `--fork-session`, which hands the parent's cost to a
 * new session_id) or a statusline switched on mid-session. Either way the
 * spend so far is not today's to count when no stored entry accounts for it.
 */
const RESTORED_FIRST_RENDER_MS = 120_000;

/**
 * Split a pre-shard `daily-costs.json` into per-session files, then remove it.
 * Without this, today's total would reset to zero once on upgrade. Two
 * processes migrating at the same time write identical shards, so it is safe
 * to run unsynchronised.
 */
function migrateLegacyStore(now: Date): void {
  const legacyPath = getLegacyPath();
  if (!fs.existsSync(legacyPath)) return; // The common case.

  // Unlike the four `readJsonValidated` call sites, this caller cannot treat
  // "unreadable" and "unparseable" the same way: the unlink below depends on
  // directory permissions, not file permissions, so it will typically
  // *succeed* even when the read just failed (e.g. a root-owned file left by
  // one `sudo` invocation). Deleting the evidence on a transient read error
  // is exactly the bug this function exists to avoid, so read it locally
  // instead of through the shared two-outcome helper.
  let raw: string;
  try {
    raw = fs.readFileSync(legacyPath, "utf-8");
  } catch {
    return; // Unreadable (EACCES/EMFILE/EIO): keep the file, retry next render.
  }

  // From here the file was read successfully. A null result means it parsed
  // to JSON that does not match the schema, or did not parse at all — either
  // way retrying cannot help, so fall through and let it be deleted below.
  let legacy: v.InferOutput<typeof LegacyStoreSchema> | null;
  try {
    const result = v.safeParse(LegacyStoreSchema, JSON.parse(raw));
    legacy = result.success ? result.output : null;
  } catch {
    legacy = null;
  }

  const sessions = legacy?.sessions ?? [];
  const date = legacy?.date ?? localDateKey(now);

  try {
    for (const sessionRaw of sessions) {
      const parsed = v.safeParse(LegacyEntrySchema, sessionRaw);
      if (!parsed.success) continue;
      const s = parsed.output;

      const target = shardPath(s.sessionId);
      // A shard already written by the new code is newer than the legacy file.
      if (fs.existsSync(target)) continue;

      const entry: SessionCostEntry = {
        sessionId: s.sessionId,
        date,
        costUsd: s.costUsd,
        baselineUsd: s.baselineUsd,
        source: s.source,
        updatedAt: s.updatedAt ?? now.getTime(),
        uncertain: false,
      };
      writeJsonAtomic(target, entry);
    }
  } catch {
    // A shard write failed (disk full, permissions). Sessions after the failure
    // exist only in the legacy file, so keep it and retry on the next render —
    // deleting it here would drop their spend for the rest of the day. Already
    // migrated sessions are skipped by the existsSync check above.
    return;
  }

  try {
    fs.unlinkSync(legacyPath);
  } catch {
    // Already gone (a concurrent migration got there first).
  }
}

/**
 * Every live session's entry. Shards untouched for 48h are pruned in passing;
 * entries from an earlier day are returned as they are, and re-baseline
 * lazily when their own session next writes.
 */
function readEntries(now: Date): SessionCostEntry[] {
  migrateLegacyStore(now);

  let files: string[];
  try {
    files = fs.readdirSync(getShardDir());
  } catch {
    return []; // No store yet.
  }

  const entries: SessionCostEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fullPath = path.join(getShardDir(), file);

    const entry = readJsonValidated(fullPath, ShardSchema);
    if (!entry) continue; // Unreadable shard: one session's data, not the whole day.

    if (now.getTime() - entry.updatedAt >= STALE_SESSION_MS) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Pruning is best effort; a stale entry contributes nothing anyway.
      }
      continue;
    }

    entries.push(entry);
  }
  return entries;
}

/**
 * The entry `trackDailyCost` would store for this render. Pure: `prev` is not
 * mutated, so the caller can discard the result if it isn't safe to write.
 */
function nextEntry(
  prev: SessionCostEntry | undefined,
  input: DailyCostInput & { sessionId: string },
  newBaseline: number,
  today: string,
  now: Date,
): SessionCostEntry {
  const { sessionId, costUsd, source, processStart } = input;
  const uncertain = input.uncertain ?? false;
  if (!prev) {
    return {
      sessionId,
      date: today,
      costUsd,
      baselineUsd: newBaseline,
      source,
      updatedAt: now.getTime(),
      processStart,
      uncertain,
    };
  }
  // `processStart` stays the FIRST value seen. It names the shard file, so
  // refining it (say, to the minimum, since each estimate is late by the
  // spawn delay) would move the entry to a new file on every render that came
  // in a little earlier and leave the old file behind, counted twice. The
  // match tolerance absorbs the jitter, and comparing against a fixed value
  // means it can't accumulate.
  const entry = { ...prev, uncertain };
  if (entry.date !== today) {
    // New day: carry the session forward, resetting its baseline to the
    // last cumulative cost so only post-midnight spend counts as today's.
    entry.baselineUsd = entry.costUsd;
    entry.date = today;
  }
  const accruedToday = Math.max(0, entry.costUsd - entry.baselineUsd);
  if (entry.source !== undefined && entry.source !== source) {
    // The accrued spend carried across includes the old source's figure, so a
    // lower bound there is still a lower bound today (COR-009).
    if (prev.uncertain && prev.date === today) entry.uncertain = true;
    // Stdin and JSONL-calculated costs use different scales, so a drop
    // across a source switch is not a restart. Re-baseline so today's
    // accrued spend carries over unchanged into the new scale.
    entry.baselineUsd = costUsd - accruedToday;
  } else if (costUsd < entry.costUsd) {
    // A restarted session reuses the ID with a reset cumulative cost
    // (cumulative cost never decreases within one process). Fold the
    // already-accrued today delta into the baseline (as a negative
    // offset) so prior spend since midnight is preserved.
    entry.baselineUsd = -accruedToday;
  }
  entry.costUsd = costUsd;
  entry.source = source;
  entry.updatedAt = now.getTime();
  return entry;
}

export interface DailyCostInput {
  sessionId: string | undefined;
  costUsd: number;
  source: CostSource;
  /** `now - cost.total_duration_ms`; omit when the payload has no duration. */
  processStart?: number;
  /** The cost is a lower bound (unpriced or approximated models). */
  uncertain?: boolean;
}

export interface DailyCostResult {
  totalUsd: number;
  /**
   * Today's total is not exact: some session's figure is a lower bound, or a
   * session's latest cost could not be recorded (non-finite, an overflowing
   * re-baseline, or an unwritable store) so its stored figure is stale.
   */
  uncertain: boolean;
}

/**
 * The stored entry this render belongs to, and the baseline a new entry
 * should start from.
 *
 * With a `processStart` (stdin costs only; see `recordDailyCost`), each Claude
 * Code process gets its own entry, in its own shard file, so two processes
 * never write the same file and the REL-001 single-writer property holds per
 * process. Keyed by session alone, two terminals on one session_id read every
 * alternation between their independent cumulative costs as a restart and
 * folded the other process's whole cost into Today each time (COR-005).
 *
 * Without one, the render updates the session's most recently updated entry
 * of any kind. A calculated cost is the whole session's transcript, so every
 * process reports the same series and must share one entry; and one process
 * whose payload sometimes lacks a duration must not grow a second entry.
 *
 * A NEW process entry's baseline, in order:
 * - the largest cost stored for this session, from the same source, that its
 *   first figure reaches. `--resume` restores the cumulative cost saved at
 *   the previous process's exit, which is already counted in that entry;
 *   baselining at the stored figure, not the first one, keeps a turn that ran
 *   before the first render. Same source only: stdin and calculated figures
 *   are on different scales.
 * - its first figure, when the session's only figures are from the other
 *   source (the same spend, re-scaled; the existing entry keeps what it
 *   counted) or the first render is late enough to be restored with nothing
 *   stored to account for it (`RESTORED_FIRST_RENDER_MS`).
 * - otherwise 0: a fresh process, concurrent or first, counts from zero.
 */
function findEntry(
  entries: SessionCostEntry[],
  input: DailyCostInput & { sessionId: string },
  now: Date,
): { index: number; newBaseline: number } {
  const { sessionId, processStart, costUsd, source } = input;
  const session: number[] = [];
  entries.forEach((e, i) => {
    if (e.sessionId === sessionId) session.push(i);
  });

  if (processStart === undefined) {
    let index = -1;
    for (const i of session) {
      if (index === -1 || entries[i]!.updatedAt > entries[index]!.updatedAt) index = i;
    }
    return { index, newBaseline: 0 };
  }

  let index = -1;
  let best = Infinity;
  for (const i of session) {
    const e = entries[i]!;
    if (e.processStart === undefined) continue;
    const gap = Math.abs(e.processStart - processStart);
    if (gap <= PROCESS_START_TOLERANCE_MS && gap < best) {
      best = gap;
      index = i;
    }
  }
  if (index !== -1) return { index, newBaseline: 0 };

  let newBaseline = 0;
  let restoredFrom = false;
  for (const i of session) {
    const e = entries[i]!;
    if (e.source === source && e.costUsd <= costUsd && e.costUsd >= newBaseline) {
      newBaseline = e.costUsd;
      restoredFrom = true;
    }
  }
  if (!restoredFrom) {
    const otherSourceOnly = session.length > 0 && session.every((i) => entries[i]!.source !== source);
    const lateFirstRender = now.getTime() - processStart > RESTORED_FIRST_RENDER_MS;
    if (otherSourceOnly || lateFirstRender) newBaseline = costUsd;
  }
  return { index: -1, newBaseline };
}

/**
 * Record the current session's cumulative cost and return today's total
 * across all sessions (spend since local midnight only), with whether that
 * total is exact.
 *
 * A non-finite `costUsd` is not recorded: the cost itself is left exactly as
 * it was and today's total uses its last good figure. Persisting it would
 * write `"costUsd": null` (`JSON.stringify(Infinity)`), which `ShardSchema`
 * rejects on the next read, silently dropping the session from every bar's
 * total and losing its baseline (#145). Ingestion rejects non-finite token
 * counts, but finite ones can still overflow once priced and summed, and two
 * finite stored values can differ by more than Number.MAX_VALUE, so the
 * re-baseline arithmetic is checked on what would be written, not only on
 * the argument. Either way the entry is re-stamped `uncertain`, so other
 * sessions' bars mark the stale figure too (COR-009).
 *
 * The shard write is caught. It was the one render-path write that was not,
 * so a root-owned or full cache directory threw into `main().catch()` and
 * erased the bar on every render (REL-005). A failed write costs the store
 * update and marks Today uncertain; this render's own figure is still exact.
 */
export function recordDailyCost(input: DailyCostInput, now: Date = new Date()): DailyCostResult {
  const today = localDateKey(now);
  const entries = readEntries(now);
  let notRecorded = false;

  const { sessionId } = input;
  if (sessionId) {
    // Per-process entries for stdin costs only: Claude Code's stdin figure is
    // one process's cumulative cost, while a calculated figure is the whole
    // session's transcript, which every process of the session reports alike.
    const processStart = input.source === "stdin" ? input.processStart : undefined;
    const keyed = { ...input, sessionId, processStart };
    const { index, newBaseline } = findEntry(entries, keyed, now);
    const prev = index === -1 ? undefined : entries[index];
    const next = Number.isFinite(input.costUsd)
      ? nextEntry(prev, keyed, newBaseline, today, now)
      : undefined;

    if (next && Number.isFinite(next.costUsd) && Number.isFinite(next.baselineUsd)) {
      if (index === -1) entries.push(next);
      else entries[index] = next;
      notRecorded = !tryWrite(next);
    } else {
      notRecorded = true;
      if (prev && !prev.uncertain) {
        const stale = { ...prev, uncertain: true };
        entries[index] = stale;
        tryWrite(stale);
      } else if (!prev) {
        // Nothing stored yet: record the session as present but unknown, so
        // other sessions' bars mark Today rather than silently omit it.
        const placeholder: SessionCostEntry = {
          sessionId,
          date: today,
          costUsd: 0,
          baselineUsd: 0,
          source: input.source,
          updatedAt: now.getTime(),
          processStart,
          uncertain: true,
        };
        entries.push(placeholder);
        tryWrite(placeholder);
      }
    }
  }

  let totalUsd = 0;
  let uncertain = notRecorded;
  for (const e of entries) {
    if (e.date !== today) continue;
    totalUsd += Math.max(0, e.costUsd - e.baselineUsd);
    if (e.uncertain) uncertain = true;
  }
  return { totalUsd, uncertain };
}

function tryWrite(entry: SessionCostEntry): boolean {
  try {
    writeJsonAtomic(shardPath(entry.sessionId, entry.processStart), entry);
    return true;
  } catch {
    return false;
  }
}

/** `recordDailyCost` for callers that need only the total. */
export function trackDailyCost(
  sessionId: string | undefined,
  costUsd: number,
  source: CostSource,
  now: Date = new Date(),
): number {
  return recordDailyCost({ sessionId, costUsd, source }, now).totalUsd;
}
