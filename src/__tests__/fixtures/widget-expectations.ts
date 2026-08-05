/**
 * What every registered widget is expected to render against the real payload
 * fixtures.
 *
 * `text` is the EXACT string observed against `opus5-1m-mid`. Asserting exact
 * text rather than "non-empty or null" is deliberate: every one of the 26
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
  /**
   * Issue number tracking confirmed-wrong output. No entry carries one right
   * now — #58 and #60–#63 were the last, and all are fixed. The field stays
   * because it is the mechanism for the next defect this harness surfaces.
   */
  knownWrong?: number;
}

export const WIDGET_EXPECTATIONS: Record<string, WidgetExpectation> = {
  model: { text: "Opus 5", why: "formatModelName strips the [1m] suffix" },
  "session-cost": { text: "$23.53", why: "sessionCostUsd from the recorded pipeline run" },
  "today-spend": { text: "Today: $609", why: "todayCostUsd from the daily cost tracker" },
  "block-timer": { text: "Block: 2hr 13m", why: "block.elapsedMs, clock pinned to derivedAt" },
  "burn-rate": { text: "$13.27/hr", why: "recorded burnRate" },
  "context-percent": { text: "[===-------] 27% (1.00M)", why: "used_percentage against a 1M window" },
  "git-branch": { text: "reality-fixture", why: "scratch repo branch" },
  "git-changes": { text: "+1", why: "scratch repo has one added file" },
  "tokens-input": { text: "In: 396", why: "metrics.totals.inputTokens — uncached input only" },
  "tokens-output": { text: "Out: 137.8k", why: "metrics.totals.outputTokens, real session total" },
  "tokens-cached": {
    text: "Cached: 35.37M",
    why: "cacheCreation + cacheRead. Labelled 'Cached:' so it cannot be confused with cache-hit-rate's 'Hit:' percentage — both said 'Cache:' (#60 resolved)",
  },
  "per-model": {
    text: "Opus 5:$22.52",
    why: "one model this session, name rendered in full. The first-letter-per-word abbreviation was removed rather than repaired: it collapsed 'Sonnet 4.5' and 'Sonnet 4' to the same 'S4' (#63 resolved)",
  },
  "session-clock": {
    text: "Session: 2hr 13m",
    why: "derivedAt - sessionStartTime, i.e. since the transcript's first entry — the whole logical session, unaffected by --resume. 'Session:' distinguishes it from session-timer's process uptime; both rendered a bare duration before (#61 resolved)",
  },
  cwd: {
    text: "~/projects/demo-project",
    why: "full path, home abbreviated — correct for cwd's own job. The project identifier moved to the `project` widget, which reads workspace.project_dir (#59 resolved)",
  },
  project: {
    text: "demo-project",
    why: "basename(workspace.project_dir) — the repo root, never the session's cwd",
  },
  "custom-text": { text: null, why: "declines without user-supplied text — correct" },
  "custom-command": { text: null, why: "declines without a configured command — correct" },
  separator: { text: " | ", why: "structural widget, renders its glyph" },
  "cache-hit-rate": {
    text: "Hit: 100%",
    why: "cache_read / (read + creation), labelled 'Hit:' to match the widget's own name and stay distinct from tokens-cached's 'Cached:' count (#60 resolved)",
  },
  "lines-changed": { text: "+649 -66", why: "cost.total_lines_added / removed" },
  "vim-mode": { text: null, why: "declines when vim mode is off — correct" },
  "api-latency": {
    text: "API total: 35m 5s",
    why: "cumulative total_api_duration_ms across every request in the session. Labelled 'API total:' because 'API: 35m 5s' read as one request hanging for half an hour (#62 resolved); the registry key stays api-latency so existing layouts keep working",
  },
  "token-breakdown": {
    text: "In:396 Out:137.8k",
    why: "metrics.totals (#58) — the same source tokens-input and tokens-output read, so all three now agree about one session. Was In:268.8k Out:536 from context_window.total_input/output_tokens, a last-assistant-message snapshot",
  },
  "session-timer": {
    text: "Up: 1hr 46m",
    why: "cost.total_duration_ms = Date.now() - the CLI process start time (2.1.220: sMe() over Mt.startTime, which ignores the sessionLogicalStartTime the binary tracks separately), so it resets on --resume. 'Up:' names it as process uptime, distinct from session-clock's 'Session:' (#61 resolved). The 27-minute gap from session-clock on this fixture is a resumed session, not a bug in either",
  },
  "compact-countdown": { text: "~697.0k left", why: "windowSize - used - 33k reserve" },
  "turn-counter": {
    text: "#9",
    why: "controlled.turnCount fixture input (9). Derived per render from the transcript's origin.kind === 'human' entries (#129), so it is a property of the captured session rather than of generation order — the pre-#129 tracker started every fresh shard at 1, so a recorded value encoded only when the fixture was generated",
  },
};
