/**
 * The set of backgrounds widgets choose at render time (from thresholds,
 * modes or levels) rather than from configured colors — so they never
 * appear in DEFAULT_SETTINGS and a static scan of the config misses them
 * entirely.
 *
 * These colours are not independent choices: each is required to stay
 * CIEDE2000-distinct from every other one a segment could end up adjacent
 * to (issues #36, #40, #45, #139). Keeping them in one module, rather
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

// vim-mode follows today-spend on line 2 — retiring api-latency removed the
// segment that used to separate them, and while burn-rate now sits between
// the two (#139), it declines until there is a rate to show, leaving them
// adjacent again. The powerline arrow is
// drawn in the previous segment's bg, so any color shared with today-spend's
// runtime bg makes that arrow invisible. Both of these are therefore chosen
// to differ from every color today-spend can render: #26a269 (default),
// ALERT_AMBER (>= dailyWarn), ALERT_RED (>= dailyDanger) — AND from
// burn-rate's #555555, their left neighbour whenever burn-rate renders (#139;
// currently ΔE ~42/44). Retuning either must clear all four.
export const VIM_NORMAL = "#2ec27e"; // green, vs today-spend's #26a269
export const VIM_INSERT = "#e5a50a"; // amber, vs today-spend's warn ALERT_AMBER

// effort's per-level palette (#139), a cool-to-warm ramp so a costly level
// left on by accident stands out. effort sits between model (#1a5fb4) and
// session-cost (#26a269 / ALERT_AMBER / ALERT_RED) on line 1, and in compact
// mode — ordered by priority, with any neighbour possibly hidden — beside
// anything. Each value is therefore checked against EVERY background the bar
// can paint, not just its configured neighbours (defaults.test.ts).
export const EFFORT_LOW = "#77767b"; // grey
export const EFFORT_MEDIUM = "#2a8ca6"; // teal-blue, vs context-percent/lines-changed #0d7377
export const EFFORT_HIGH = "#5841c8"; // violet — the default level, so deliberately calm
export const EFFORT_XHIGH = "#b0228c"; // magenta
export const EFFORT_MAX = "#e66100"; // burnt orange, vs the amber/red alert pairs

/**
 * Level → background. A Map, not an object literal: an object would answer
 * `"constructor"` or `"toString"` with an inherited function, and the level
 * string comes from the payload.
 */
export const EFFORT_COLORS: ReadonlyMap<string, string> = new Map([
  ["low", EFFORT_LOW],
  ["medium", EFFORT_MEDIUM],
  ["high", EFFORT_HIGH],
  ["xhigh", EFFORT_XHIGH],
  ["max", EFFORT_MAX],
]);

/** A level this build has never seen renders neutral rather than vanishing. */
export const EFFORT_FALLBACK = EFFORT_LOW;

/**
 * Every background above, chosen at render time (from thresholds, modes or
 * levels) rather than from configured colours, as a set. Import this — don't
 * restate the values — so a new runtime colour lands under any guard
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
  EFFORT_LOW,
  EFFORT_MEDIUM,
  EFFORT_HIGH,
  EFFORT_XHIGH,
  EFFORT_MAX,
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
 *
 * A non-finite cost renders as "$?": the amount is unknown, so it is not
 * known to be past either threshold. Without the guard Infinity painted red
 * and NaN (every comparison false) the configured colour, so the same "$?"
 * looked different depending on how it went wrong.
 */
export function alertBg(
  cost: number,
  warn: number,
  danger: number,
  configBg?: string,
): string | undefined {
  if (!Number.isFinite(cost)) return configBg;
  if (cost >= danger) return ALERT_RED;
  if (cost >= warn) return ALERT_AMBER;
  return configBg;
}
