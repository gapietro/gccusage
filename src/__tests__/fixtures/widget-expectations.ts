/**
 * What every registered widget is expected to render against the real payload
 * fixtures.
 *
 * `text` is the EXACT string observed against `opus5-1m-mid`. Asserting exact
 * text rather than "non-empty or null" is deliberate: every one of the 25
 * widgets returns a plausible non-empty string against a real payload, so a
 * smoke test passes on all of them and catches nothing (#47).
 *
 * `knownWrong` marks output that is confirmed incorrect and tracked by an
 * issue. The assertion still encodes CURRENT behaviour so the suite stays
 * green; the tag keeps the defect visible here and forces a deliberate edit
 * when it is fixed.
 *
 * Why record wrong-but-current output instead of the other two options:
 * - A red suite (asserting the CORRECT value while the widget is still
 *   broken) trains everyone to ignore failing tests, and the first thing a
 *   future contributor does with a red suite is delete or skip the failing
 *   case — which is exactly how these 12 widgets went unexercised in the
 *   first place (#47).
 * - A silent gap (leaving the widget out of the table, or asserting
 *   "non-empty") hides the defect entirely; nothing fails, nothing points at
 *   an issue, and the bug has no tripwire for regressing further.
 * - Recording the confirmed-wrong value plus a `knownWrong` issue number does
 *   both jobs at once: the suite stays green (so it stays trustworthy and
 *   nobody is tempted to silence it), and the defect stays visible in the one
 *   place a reviewer or fixer will look. Fixing the widget requires a
 *   deliberate edit to this file, which is the point — the change forces
 *   whoever fixes the underlying bug to also affirmatively update the
 *   recorded expectation, so the table never drifts back into being untested.
 */
export interface WidgetExpectation {
  /** Exact text against opus5-1m-mid, or null when the widget declines to render. */
  text: string | null;
  /**
   * Why `text` is the right output; or why the widget correctly declines
   * (`text: null`); or, for `knownWrong` entries, the mechanism that
   * produces this known-wrong value (not an argument that it is correct).
   */
  why: string;
  /** Issue number tracking confirmed-wrong output. */
  knownWrong?: number;
}

export const WIDGET_EXPECTATIONS: Record<string, WidgetExpectation> = {
  model: { text: "Opus 5", why: "formatModelName strips the [1m] suffix" },
  "session-cost": { text: "$4.32", why: "sessionCostUsd from the recorded pipeline run" },
  "today-spend": { text: "Today: $521", why: "todayCostUsd from the daily cost tracker" },
  "block-timer": { text: "Block: 1hr 39m", why: "block.elapsedMs, clock pinned to derivedAt" },
  "burn-rate": { text: "$9.34/hr", why: "recorded burnRate" },
  "context-percent": { text: "[=---------] 12% (1.00M)", why: "used_percentage against a 1M window" },
  "git-branch": { text: "reality-fixture", why: "scratch repo branch" },
  "git-changes": { text: "+1", why: "scratch repo has one added file" },
  "tokens-input": { text: "In: 122", why: "metrics.session.inputTokens — uncached input only" },
  "tokens-output": { text: "Out: 37.7k", why: "metrics.session.outputTokens, real session total" },
  "tokens-cached": { text: "Cache: 5.24M", why: "cacheCreation + cacheRead", knownWrong: 60 },
  "per-model": { text: "O5:$4.13", why: "one model this session", knownWrong: 63 },
  "session-clock": { text: "28m 9s", why: "derivedAt - sessionStartTime", knownWrong: 61 },
  cwd: { text: "~/projects/demo-project/src/widgets", why: "full path, home abbreviated", knownWrong: 59 },
  "custom-text": { text: null, why: "declines without user-supplied text — correct" },
  "custom-command": { text: null, why: "declines without a configured command — correct" },
  separator: { text: " | ", why: "structural widget, renders its glyph" },
  "cache-hit-rate": { text: "Cache: 99%", why: "cache_read / (read + creation)", knownWrong: 60 },
  "lines-changed": { text: "+112 -7", why: "cost.total_lines_added / removed" },
  "vim-mode": { text: null, why: "declines when vim mode is off — correct" },
  "api-latency": { text: "API: 8m 26s", why: "cumulative total_api_duration_ms", knownWrong: 62 },
  "token-breakdown": { text: "In:117.3k Out:3", why: "context_window totals — a last-message snapshot", knownWrong: 58 },
  "session-timer": { text: "27m 44s", why: "cost.total_duration_ms", knownWrong: 61 },
  "compact-countdown": { text: "~847.0k left", why: "windowSize - used - 33k reserve" },
  "turn-counter": {
    text: "#9",
    why: "controlled.turnCount fixture input (9) — the live turn tracker is a single-slot cache and cannot be recorded retroactively",
  },
};
