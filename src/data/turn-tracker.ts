import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir, shardKey } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";

// `JSON.parse("null")` succeeds and yields null, which the old `as TurnData`
// cast then dereferenced outside the try block — throwing, and blanking the
// entire statusline over a four-byte cache file (#92).
//
// `updatedAt` falls back to 0 so a shard written in an older format reads as
// infinitely stale and is pruned, rather than surviving forever unpruneable.
const TurnDataSchema = v.object({
  sessionId: v.string(),
  count: v.number(),
  updatedAt: v.fallback(v.number(), 0),
});

type TurnData = v.InferOutput<typeof TurnDataSchema>;

// Matches the daily cost store's retention today, but deliberately its own
// constant: the two stores' policies are independent and there is no reason
// for them to have to move together.
const STALE_TURN_MS = 48 * 3600 * 1000;

function getTurnDir(): string {
  return path.join(getCacheDir(), "turns");
}

/**
 * One file per session, so a render only ever writes its own session's data.
 * A single global file reset the count to 1 on every alternating render once
 * two sessions were open (#99) — the same defect the daily cost store had
 * before it was sharded in #81.
 */
function turnShardPath(sessionId: string): string {
  return path.join(getTurnDir(), `${shardKey(sessionId)}.json`);
}

function getLegacyTurnPath(): string {
  return path.join(getCacheDir(), "turn-count.json");
}

/**
 * Bound the store's growth without adding a directory scan to every render.
 *
 * Called only when this session has no shard yet, which happens once per
 * session rather than once per render. Sharding otherwise trades a per-render
 * write for a per-render `readdir`, which is not a fix.
 */
function pruneStaleShards(now: number): void {
  // The pre-shard global file. Its value is deliberately not migrated: it
  // holds one count, for one session, for a widget in no default layout, and
  // the counter resets on session change by design.
  try {
    fs.unlinkSync(getLegacyTurnPath());
  } catch {
    // Absent, which is the common case after the first upgrade.
  }

  let files: string[];
  try {
    files = fs.readdirSync(getTurnDir());
  } catch {
    return; // No store yet.
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fullPath = path.join(getTurnDir(), file);

    const entry = readJsonValidated(fullPath, TurnDataSchema);
    // A null here is either a corrupt shard or one we failed to read, and
    // those are indistinguishable from outside. Deleting a file we merely
    // could not read is the mistake `migrateLegacyStore` exists to avoid, so
    // leave it. The leak is bounded by the number of sessions that ever
    // suffered a torn write, at roughly 60 bytes each.
    if (!entry) continue;

    if (now - entry.updatedAt < STALE_TURN_MS) continue;

    try {
      fs.unlinkSync(fullPath);
    } catch {
      // Best effort; a stale shard contributes nothing anyway.
    }
  }
}

/**
 * Increment and return the turn count for the given session.
 * Resets when the session ID changes.
 *
 * Note this counts renders that missed the statusline cache, not turns:
 * `runStatusline` returns from cache before the pipeline runs. That predates
 * sharding and is unchanged here.
 */
export function trackTurn(sessionId: string | undefined): number {
  if (!sessionId) return 0;

  const filePath = turnShardPath(sessionId);
  const now = Date.now();
  const existing = readJsonValidated(filePath, TurnDataSchema);

  // No shard for this session yet — the once-per-session moment to sweep. A
  // corrupt shard also reads as null and sweeps too, which is harmless: the
  // sweep only removes files that are independently stale.
  if (existing === null) {
    pruneStaleShards(now);
  }

  // Unsafe session ids share a hashed key space, so two ids could in
  // principle land on one file. Keeping the id in the document lets that be
  // detected rather than silently continuing another session's count.
  const data: TurnData =
    existing && existing.sessionId === sessionId
      ? { sessionId, count: existing.count + 1, updatedAt: now }
      : { sessionId, count: 1, updatedAt: now };

  // Atomic replacement, but deliberately no lock: one session writes only its
  // own shard, so there is no shared read-modify-write left to lose.
  writeJsonAtomic(filePath, data);

  return data.count;
}
