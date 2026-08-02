/**
 * Build-number badge: `MMDD.<pushes to main that day>`.
 *
 * The count answers "how many times did main move today", so it resets with
 * the date rather than accumulating. `0802.1` follows `0801.9` — the count
 * orders builds within a day and the date orders the days.
 *
 * Everything here is pure so it can be tested without a filesystem; the entry
 * point in ../build-badge.ts does the reading and writing.
 */

/**
 * The date the count belongs to is the *local* one.
 *
 * The Action runs on a UTC runner, where a 9pm push in New York already reads
 * as tomorrow — the badge would roll over mid-evening and reset a count that
 * had not finished its day. The repo already keys `daily-costs.json` on the
 * local date for the same reason, so the zone is named here in code rather
 * than left to a `TZ` the workflow might drop.
 */
export const ZONE = "America/New_York";

export const BADGE_START = "<!-- badges:start -->";
export const BADGE_END = "<!-- badges:end -->";

/** Shown until the first real push replaces it; never a fabricated number. */
export const PENDING = "pending";

export interface BuildState {
  date: string;
  count: number;
  build: string;
}

export type RenderResult = { ok: true; readme: string } | { ok: false; error: string };

/**
 * The `YYYY-MM-DD` date in `zone` at instant `now`.
 *
 * `en-CA` is the shortest route to ISO-ordered parts from `Intl`; formatting
 * through `Intl` rather than reading `getMonth()` is what makes the zone
 * explicit instead of inherited from the runner's environment.
 */
export function todayInZone(now: Date, zone: string = ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `2026-08-01` + 3 → `0801.3`. */
export function formatBuild(date: string, count: number): string {
  return `${date.slice(5, 7)}${date.slice(8, 10)}.${count}`;
}

function storedCount(state: unknown, today: string): number {
  if (typeof state !== "object" || state === null) return 0;
  const { date, count } = state as { date?: unknown; count?: unknown };
  if (date !== today) return 0;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return 0;
  return count;
}

/**
 * The state this push should record.
 *
 * Anything unreadable — absent file, malformed JSON, a count that is not a
 * positive integer — is treated as a fresh day rather than an error. A badge
 * is not worth failing a push over, and the next push self-corrects.
 */
export function nextBuild(state: unknown, today: string): BuildState {
  const count = storedCount(state, today) + 1;
  return { date: today, count, build: formatBuild(today, count) };
}

/**
 * Escape a value for a shields.io path segment, where `-` and `_` are
 * separators: they must be doubled to render literally, and a space is `_`.
 * Without this a prerelease like `1.0.0-rc1` splits into the wrong fields and
 * the badge renders as garbage instead of failing visibly.
 */
export function shieldsEscape(value: string): string {
  return value.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_");
}

function badge(label: string, message: string, color: string): string {
  const url = `https://img.shields.io/badge/${shieldsEscape(label)}-${shieldsEscape(message)}-${color}`;
  return `![${label}](${url})`;
}

/**
 * Replace the marked block with freshly built badges.
 *
 * A missing marker is an error, not a fallback: appending or silently
 * returning the input would leave the badge permanently stale while every run
 * reported success.
 */
export function renderBadges(
  readme: string,
  values: { version: string; build: string },
): RenderResult {
  const start = readme.indexOf(BADGE_START);
  const end = readme.indexOf(BADGE_END);
  if (start === -1) return { ok: false, error: `README is missing the ${BADGE_START} marker` };
  if (end === -1) return { ok: false, error: `README is missing the ${BADGE_END} marker` };
  if (end < start) {
    return { ok: false, error: `README has ${BADGE_END} before ${BADGE_START}` };
  }

  const block = [
    BADGE_START,
    badge("version", values.version, "blue"),
    badge("build", values.build, values.build === PENDING ? "lightgrey" : "brightgreen"),
    BADGE_END,
  ].join("\n");

  return { ok: true, readme: readme.slice(0, start) + block + readme.slice(end + BADGE_END.length) };
}
