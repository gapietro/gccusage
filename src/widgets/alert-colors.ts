/**
 * The set of backgrounds widgets can paint at render time from thresholds,
 * rather than from configured colors — so they never appear in
 * DEFAULT_SETTINGS and a static scan of the config misses them entirely.
 *
 * These six colours are not six independent choices: each is required to
 * stay CIEDE2000-distinct from every other one a segment could end up
 * adjacent to (issues #36, #40, #45). Keeping them in one module, rather
 * than scattered across the widgets that use them, is what lets that
 * mutual-distinctness constraint be checked in one place instead of via
 * cross-referencing comments that can drift out of sync.
 */

// Shared amber/red alert pair — used by session-cost, today-spend, and
// context-percent, all of which cross a warn/danger threshold measured in
// dollars or tokens.
export const ALERT_AMBER = "#a67c00"; // yellow/amber
export const ALERT_RED = "#c01c28"; // red

// compact-countdown's own palette, deliberately NOT the shared amber/red
// pair above — it renders adjacent to context-percent, which already uses
// ALERT_AMBER/ALERT_RED, so reusing them would collapse the separator
// between the two segments.
export const COMPACT_COUNTDOWN_AMBER = "#b8860b"; // amber (distinct from context-percent's ALERT_AMBER)
export const COMPACT_COUNTDOWN_RED = "#a01822"; // red (distinct from context-percent's ALERT_RED)

// vim-mode sits directly after today-spend on line 2 — retiring api-latency
// removed the segment that used to separate them. The powerline arrow is
// drawn in the previous segment's bg, so any color shared with today-spend's
// runtime bg makes that arrow invisible. Both of these are therefore chosen
// to differ from every color today-spend can render: #26a269 (default),
// ALERT_AMBER (>= dailyWarn), ALERT_RED (>= dailyDanger).
export const VIM_NORMAL = "#2ec27e"; // green, vs today-spend's #26a269
export const VIM_INSERT = "#e5a50a"; // amber, vs today-spend's warn ALERT_AMBER

/**
 * Every runtime-threshold background above, as a set. Import this — don't
 * restate the values — so a seventh runtime colour lands under any guard
 * that checks against it automatically, rather than requiring someone to
 * remember to mirror it by hand.
 */
export const RUNTIME_ALERT_BACKGROUNDS = [
  ALERT_AMBER,
  ALERT_RED,
  COMPACT_COUNTDOWN_AMBER,
  COMPACT_COUNTDOWN_RED,
  VIM_NORMAL,
  VIM_INSERT,
] as const;

/**
 * The shared warn/danger escalation for the dollar-valued widgets
 * (session-cost, today-spend): red at or above `danger`, amber at or above
 * `warn`, otherwise whatever the config asked for.
 *
 * The two widgets are meant to behave identically at their thresholds and
 * differ only in which cost and which threshold pair they feed in. Held as
 * one function so that stays true by construction (#68) — as two copies, an
 * added tier or a flipped comparison in one would desynchronise the other
 * with each widget's own tests still green.
 */
export function alertBg(
  cost: number,
  warn: number,
  danger: number,
  configBg?: string,
): string | undefined {
  if (cost >= danger) return ALERT_RED;
  if (cost >= warn) return ALERT_AMBER;
  return configBg;
}
