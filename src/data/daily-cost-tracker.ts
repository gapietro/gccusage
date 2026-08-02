import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { writeJsonAtomic, readJsonValidated } from "../utils/atomic-json.js";

export type CostSource = "stdin" | "calculated";

const CostSourceSchema = v.picklist(["stdin", "calculated"]);

/**
 * The shard schema replaces four hand-rolled `typeof` checks scattered through
 * this file (#92). `v.fallback` preserves each tolerance exactly: a shard
 * written before `baselineUsd` existed reads as 0, and one with no `updatedAt`
 * reads as 0 and is therefore pruned as stale, which is what the old
 * `entry.updatedAt ?? 0` did.
 */
const ShardSchema = v.object({
  sessionId: v.string(),
  date: v.string(), // local date the baseline belongs to
  costUsd: v.number(), // latest cumulative session cost
  baselineUsd: v.fallback(v.number(), 0), // cumulative cost at the start of `date`
  // Absent in legacy files, and an unrecognised value is treated the same way.
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  updatedAt: v.fallback(v.number(), 0),
});

type SessionCostEntry = v.InferOutput<typeof ShardSchema>;

const LegacyStoreSchema = v.object({
  date: v.fallback(v.optional(v.string()), undefined),
  sessions: v.fallback(v.array(v.unknown()), []),
});

const LegacyEntrySchema = v.object({
  sessionId: v.string(),
  costUsd: v.number(),
  baselineUsd: v.fallback(v.number(), 0),
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  updatedAt: v.fallback(v.optional(v.number()), undefined),
});

const STALE_SESSION_MS = 48 * 3600 * 1000;

// The UUIDs Claude Code sends. Anything else is hashed rather than trusted:
// sessionId arrives from stdin and must never reach a path unchecked.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
function shardPath(sessionId: string): string {
  const key = SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return path.join(getShardDir(), `${key}.json`);
}

function dateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Split a pre-shard `daily-costs.json` into per-session files, then remove it.
 * Without this, today's total would reset to zero once on upgrade. Two
 * processes migrating at the same time write identical shards, so it is safe
 * to run unsynchronised.
 */
function migrateLegacyStore(now: Date): void {
  const legacyPath = getLegacyPath();
  if (!fs.existsSync(legacyPath)) return; // The common case.

  // A null result here means the file exists but carries nothing usable.
  // Fall through so it still gets deleted — retrying cannot help.
  const legacy = readJsonValidated(legacyPath, LegacyStoreSchema);
  const sessions = legacy?.sessions ?? [];
  const date = legacy?.date ?? dateStr(now);

  try {
    for (const raw of sessions) {
      const parsed = v.safeParse(LegacyEntrySchema, raw);
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
 * Record the current session's cumulative cost and return today's total
 * across all sessions (spend since local midnight only).
 */
export function trackDailyCost(
  sessionId: string | undefined,
  costUsd: number,
  source: CostSource,
  now: Date = new Date(),
): number {
  const today = dateStr(now);
  const entries = readEntries(now);

  if (sessionId) {
    let entry = entries.find((e) => e.sessionId === sessionId);
    if (entry) {
      if (entry.date !== today) {
        // New day: carry the session forward, resetting its baseline to the
        // last cumulative cost so only post-midnight spend counts as today's.
        entry.baselineUsd = entry.costUsd;
        entry.date = today;
      }
      const accruedToday = Math.max(0, entry.costUsd - entry.baselineUsd);
      if (entry.source !== undefined && entry.source !== source) {
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
    } else {
      entry = {
        sessionId,
        date: today,
        costUsd,
        baselineUsd: 0,
        source,
        updatedAt: now.getTime(),
      };
      entries.push(entry);
    }
    writeJsonAtomic(shardPath(sessionId), entry);
  }

  let total = 0;
  for (const e of entries) {
    if (e.date !== today) continue;
    total += Math.max(0, e.costUsd - e.baselineUsd);
  }
  return total;
}
