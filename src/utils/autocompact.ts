/**
 * Auto-compact prediction.
 *
 * Derived from the shipped Claude Code binary (VERSION "2.1.220",
 * BUILD_TIME 2026-07-24), not from a measured session. The relevant
 * de-minified functions:
 *
 *   CSe(model, setting) = aY(...).window - Math.min(maxOutputTokens, 20000)
 *   Sfo(eff)            = eff - 13000
 *   uMu(tokens, eff)    = tokens >= Sfo(eff) ? "compact" : ...
 *
 * `cst()` gives a default max_output_tokens of 32000, so that Math.min always
 * clamps to 20000 for current models. The threshold is therefore a fixed token
 * reserve, not a fraction of the window. The same binary corroborates this with
 * a hardcoded precompute default of 967000 for a 1M window (1_000_000 - 33_000).
 * See issue #37.
 *
 * Assumes Claude Code's defaults: auto-compact enabled and `autoCompactWindow`
 * unset. Neither is visible in the statusline payload, so a user who changes
 * either will see these predictions miss — `autoCompactWindow` makes compaction
 * fire earlier than predicted, and `autoCompactEnabled: false` means it never
 * fires at all.
 */

/** Output headroom Claude Code holds back: min(maxOutputTokens, 20_000). */
const OUTPUT_RESERVE = 20_000;

/** Fixed compaction reserve, on top of the output headroom. */
const COMPACT_RESERVE = 13_000;

/** Total tokens reserved below the window size. */
export const AUTOCOMPACT_RESERVE = OUTPUT_RESERVE + COMPACT_RESERVE;

/** Amber band: Claude Code's own "warn" level sits 20k before the threshold. */
export const AMBER_TOKENS = 20_000;

/** Red band: the last warning before compaction. */
export const RED_TOKENS = 5_000;

/**
 * Token count at which auto-compact fires.
 *
 * Null when the window is too small for the reserve to make sense — callers
 * should fall back rather than render a negative countdown.
 */
export function compactThresholdTokens(windowSize: number): number | null {
  if (!Number.isFinite(windowSize) || windowSize <= AUTOCOMPACT_RESERVE) return null;
  return windowSize - AUTOCOMPACT_RESERVE;
}

/** Tokens left before auto-compact, clamped at zero. Null when unmodellable. */
export function tokensUntilCompact(usedTokens: number, windowSize: number): number | null {
  const threshold = compactThresholdTokens(windowSize);
  if (threshold === null) return null;
  return Math.max(0, Math.round(threshold - usedTokens));
}
