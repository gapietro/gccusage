import * as v from "valibot";

/**
 * The shared rules for numbers that cross a JSON boundary: stdin and every
 * cache file. They used to be re-derived per schema, and the derivations
 * disagreed — `status-json.ts` had `finite()`, the pricing, statusline and
 * block caches had bare `v.number()`, the refresh stamp `finite()` only, and
 * the daily shard `safeInteger()` (COR-006). One owner, so the next schema
 * imports the rule rather than rediscovering it.
 */

/**
 * `v.finite()`, never bare `v.number()`.
 *
 * JSON has no `Infinity` literal, which made "JSON cannot encode it, so
 * `v.number()` is enough" a tempting and wrong conclusion. An out-of-range
 * numeric literal OVERFLOWS: `JSON.parse('{"x":1e400}').x` is `Infinity`, and
 * both `v.number()` and `typeof x === "number"` accept it (#133, #137).
 */
export function finiteNumber() {
  return v.pipe(v.number(), v.finite());
}

/**
 * A millisecond stamp this program wrote with `Date.now()`.
 *
 * `safeInteger()`, which implies finite: `finite()` alone accepts `1e300`, and
 * `now - 1e300` is as never-stale as `now - Infinity` (#130). Every stamp
 * written here is an integer, so a fraction is corruption too.
 *
 * NOT sufficient on its own. `9e15` is a safe integer — and centuries in the
 * future — and so is a stamp written before the clock was set back or a VM
 * snapshot restored. "In the future" depends on when the file is read, which a
 * schema cannot know, so every consumer must take the age through `ageSince`.
 */
export function persistedTimestamp() {
  return v.pipe(v.number(), v.safeInteger());
}

/**
 * How far in the future a stamp may be and still read as age 0.
 *
 * Every stamp is written and read on the same machine, so there is no
 * cross-host skew to absorb; a negative age can only come from the clock
 * stepping backwards between a write and a read — an NTP correction, which is
 * normally well under a second. One second absorbs that without a pointless
 * miss. It must stay small against the shortest TTL it gates, the statusline
 * cache's 5 s default: a stamp inside the allowance reads as brand new, so it
 * can stretch that TTL by up to the allowance itself.
 */
export const CLOCK_SKEW_ALLOWANCE_MS = 1000;

/**
 * The age of a persisted stamp, or `null` when the stamp cannot be trusted.
 *
 * Every cache measured age as `now - stored` and compared it against a TTL.
 * A stamp in the future made that negative, a negative age is younger than
 * every TTL, and the entry read as fresh until the clock caught up — forever,
 * for `9e15`. For the pricing cache that meant the refresher was never spawned,
 * and the refresher is the only writer of `pricing.json`: the file causing the
 * wrong answer gated its own repair, #133's shape (COR-006).
 *
 * `null` rather than `Infinity`, so the compiler makes each caller decide what
 * an untrusted age means (stale, expired, absent) instead of a comparison
 * happening to come out right. Within the skew allowance the age is clamped to
 * 0, so a caller never sees a remaining time longer than its whole window.
 */
export function ageSince(timestamp: number, now: number = Date.now()): number | null {
  const age = now - timestamp;
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_ALLOWANCE_MS) return null;
  return Math.max(0, age);
}
