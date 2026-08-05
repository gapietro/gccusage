import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { getCacheDir, ensureDir } from "../utils/paths.js";
import { writeJsonAtomic, readJsonValidated } from "../utils/atomic-json.js";

/**
 * How long to wait after an attempt before spawning another refresher.
 * Shorter than the pricing TTL on purpose: this bounds retries after a
 * FAILED attempt, whereas a success makes the cache fresh and stops the
 * spawn at source.
 */
export const REFRESH_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Exported so tests can seed the stamp to suppress the spawn, and assert it
 * was not rewritten. A test that hardcodes the name keeps passing if this is
 * renamed — it would seed a path nothing reads, and silently get a refresher
 * again (#122).
 */
export const PRICING_REFRESH_STAMP_FILE = "pricing-refresh-attempt.json";

function stampPath(): string {
  return path.join(getCacheDir(), PRICING_REFRESH_STAMP_FILE);
}

/**
 * `v.finite()`, not bare `v.number()`: `JSON.parse('{"timestamp":1e400}')`
 * yields `Infinity`, which the hand-rolled `typeof === "number"` guard this
 * replaced admitted. `Date.now() - Infinity` is `-Infinity`, always inside
 * the backoff window, and the stamp is only rewritten *after* the check — so
 * the file causing the wrong answer gated its own repair and pricing froze
 * permanently, silently (#133).
 */
const StampSchema = v.object({ timestamp: v.pipe(v.number(), v.finite()) });

function attemptedRecently(): boolean {
  // No stamp, an unreadable one, or one that fails the schema: treat as never
  // attempted. Failing open here only costs one spawn, and the stamp write
  // below re-arms the guard.
  const stamp = readJsonValidated(stampPath(), StampSchema);
  if (stamp === null) return false;
  return Date.now() - stamp.timestamp < REFRESH_BACKOFF_MS;
}

/**
 * Refreshes pricing out of band when the cache is stale, so the render path
 * never waits on the network (#84).
 *
 * The child is detached with stdio ignored and immediately unref'd: that is
 * what keeps it from holding the parent's event loop open, which was the
 * actual mechanism behind the 10.6s stall. The parent renders from the cache
 * it already has and exits; the NEXT render picks up the new prices.
 *
 * Best-effort by construction — every failure path is swallowed, because a
 * statusline that cannot refresh pricing must still draw a bar.
 */
export function maybeSpawnPricingRefresh(stale: boolean): void {
  if (!stale) return;

  try {
    if (attemptedRecently()) return;

    // Stamped BEFORE the spawn, by the parent. A child killed mid-fetch on a
    // blackholed network never reaches a stamp write of its own, so
    // child-side backoff would fail open on precisely the broken network this
    // exists for, and every prompt would spawn another refresher.
    ensureDir(getCacheDir());
    writeJsonAtomic(stampPath(), { timestamp: Date.now() });

    // Our own file, not process.argv[1]. Everything ships as one bundle, so
    // this resolves to dist/index.js — the file that handles the command —
    // whether the statusline was invoked as `node .../dist/index.js` or
    // through the `gccusage` bin symlink, where argv[1] is the symlink and
    // the refresh would silently never happen.
    //
    // process.execPath is the Node already running us, not a path persisted
    // into a config file, so this is not the versioned-path hazard of #90.
    const entry = fileURLToPath(import.meta.url);

    const child = spawn(process.execPath, [entry, "refresh-pricing"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // ignore
  }
}
