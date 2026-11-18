import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { getCacheDir, ensureDir } from "../utils/paths.js";
import { writeJsonAtomic, readJsonValidated } from "../utils/atomic-json.js";
import { ageSince, persistedTimestamp } from "../utils/schemas.js";

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

function stampPath(cacheDir: string): string {
  return path.join(cacheDir, PRICING_REFRESH_STAMP_FILE);
}

/**
 * `v.finite()`, not bare `v.number()`: `JSON.parse('{"timestamp":1e400}')`
 * yields `Infinity`, which the hand-rolled `typeof === "number"` guard this
 * replaced admitted. `Date.now() - Infinity` is `-Infinity`, always inside
 * the backoff window, and the stamp is only rewritten *after* the check — so
 * the file causing the wrong answer gated its own repair and pricing froze
 * permanently, silently (#133).
 *
 * `finite()` closed that for `1e400` only: any finite stamp in the future
 * (`9e15`, a clock set backwards) gave the same negative age, and latched the
 * backoff until the clock caught up. Hence `persistedTimestamp()` plus
 * `ageSince` below (COR-006).
 */
const StampSchema = v.object({ timestamp: persistedTimestamp() });

function attemptedRecently(cacheDir: string): boolean {
  // No stamp, an unreadable one, one that fails the schema, or one in the
  // future: treat as never attempted. Failing open here only costs one spawn,
  // and the stamp write below re-arms the guard from the current clock.
  const stamp = readJsonValidated(stampPath(cacheDir), StampSchema);
  if (stamp === null) return false;
  const age = ageSince(stamp.timestamp);
  return age !== null && age < REFRESH_BACKOFF_MS;
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

  // No cache dir (SEC-004): the child would have nowhere to save prices, and
  // with no stamp to write there is no backoff either — every render would
  // spawn another refresher. Render from the bundled fallback instead.
  const cacheDir = getCacheDir();
  if (cacheDir === null) return;

  try {
    if (attemptedRecently(cacheDir)) return;

    // Stamped BEFORE the spawn, by the parent. A child killed mid-fetch on a
    // blackholed network never reaches a stamp write of its own, so
    // child-side backoff would fail open on precisely the broken network this
    // exists for, and every prompt would spawn another refresher.
    ensureDir(cacheDir);
    writeJsonAtomic(stampPath(cacheDir), { timestamp: Date.now() });

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
    // A spawn that fails (EAGAIN at the process limit, ENOENT for a vanished
    // execPath) does not throw here: Node emits `error` on the ChildProcess on
    // a later tick, after this function and its try/catch have returned. With
    // no listener that emit is an uncaught exception — the render exits 1 with
    // a stack trace on stderr, the one place GCCUSAGE_DEBUG exists to keep it
    // out of (REL-006). Swallowed like every other failure here, and surfaced
    // under the same gate `main()` uses.
    child.on("error", (err) => {
      if (process.env["GCCUSAGE_DEBUG"]) {
        console.error("gccusage: pricing refresher failed to spawn —", err.message);
      }
    });
    child.unref();
  } catch {
    // ignore
  }
}
