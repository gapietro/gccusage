/**
 * The local calendar date as `YYYY-MM-DD`: the key both daily stores reset on
 * (the per-session cost shards and the today-aggregate cache).
 *
 * One owner on purpose (MAINT-003). The two stores used to carry identical
 * private copies, and they must roll over at the same instant: if one moved to
 * UTC or a zone override and the other didn't, `Today:` and the calculated
 * today figure would reset at different times. Local, not UTC, to match
 * `isEntryFromToday`'s local midnight.
 */
export function localDateKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
