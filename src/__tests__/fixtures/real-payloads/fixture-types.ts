import type { TokenMetrics } from "../../../types/token-metrics.js";
import type { BlockMetrics } from "../../../types/block-metrics.js";
import type { BurnRate } from "../../../types/burn-rate.js";

/**
 * A real Claude Code statusline payload plus the RenderContext values a real
 * pipeline run derived from it.
 *
 * The derived block is RECORDED, not invented. Hand-written context values are
 * exactly the failure mode #47 exists to close: they encode what we believe the
 * pipeline produces rather than what it does produce.
 */
export interface RealPayloadFixture {
  name: string;
  claudeCodeVersion: string;
  /**
   * Epoch ms when `derived` was computed (the instant `buildRenderContext()`
   * ran during fixture generation) — NOT when `stdin` was captured. The raw
   * `stdin` line was tee-captured earlier (up to ~30 minutes earlier, in this
   * corpus); `derived` was computed later, against the live JSONL transcript
   * for that same session, which keeps growing in between. `stdin` and
   * `derived` are therefore two different instants of the SAME session, not
   * one simultaneous snapshot. Pin `Date.now()` to this value when testing
   * elapsed-time widgets.
   */
  derivedAt: number;
  /** Absolute path prefix standing in for the real home dir in sanitized paths. */
  homePlaceholder: string;
  /** The raw payload as Claude Code sent it, with identifying values replaced. */
  stdin: Record<string, unknown>;
  /**
   * Values computed by a real `buildRenderContext()` run against the real
   * session transcript. RECORDED, not invented — hand-written context values
   * are exactly the failure mode #47 exists to close: they encode what we
   * believe the pipeline produces rather than what it does produce. Never
   * hand-edit anything in this block; if a value needs to change, regenerate
   * the fixture.
   */
  derived: {
    /**
     * The metrics as RECORDED at capture time, declared explicitly rather than
     * derived from the live `AggregatedMetrics`. These fixtures are a recording
     * of what the pipeline produced then, and the live type has since changed
     * (`session` -> `totals`, `today` dropped in #94). `context-from-fixture.ts`
     * adapts the recording to the current type; re-capturing to chase a type
     * rename would throw away the "real payload" property they exist for.
     * `byModel` is entries, not a Map, because Maps don't survive JSON.
     */
    metrics: {
      byModel: [string, TokenMetrics][];
      session: TokenMetrics;
      today: TokenMetrics;
    };
    sessionCostUsd: number;
    todayCostUsd: number;
    /** Map is not JSON-serialisable; stored as entries. */
    costByModel: [string, number][];
    sessionStartTime: number | null;
    block: BlockMetrics | null;
    burnRate: BurnRate | null;
  };
  /**
   * Values supplied by hand rather than captured during fixture generation —
   * as opposed to `derived`, which is recorded automatically. That
   * distinction still holds in general, but overstates the current
   * `turnCount` specifically: as explained below, its value is an unverified
   * leftover, not a considered choice. `turnCount` used to live here because
   * the pre-#129
   * `turn-tracker.ts` persisted a counter sharded per session id
   * (`<cacheDir>/turns/<shardKey(sessionId)>.json`), and a fresh shard always
   * started at count 1: generating fixtures for three different session ids
   * in one process would have produced a "recorded" turnCount that only
   * encoded generation order (which fixture ran first), never a real
   * session's accumulated turn count.
   *
   * #129 deleted that store: `turnCount` is now `countHumanTurns
   * (sessionEntries)`, derived fresh on every render straight from the
   * transcript's `origin.kind === "human"` entries, with nothing persisted
   * and nothing to shard or reset. A regenerated fixture's turnCount is
   * therefore just as real a recording as anything under `derived`, and the
   * original reason it was excluded (generation-order sensitivity) no
   * longer applies — it COULD now be promoted into `derived` and captured
   * automatically. It stays under `controlled` only because doing that means
   * regenerating the fixture corpus (see capture.md's "Refreshing the
   * corpus"), which was out of scope for this documentation pass — not
   * because `context-from-fixture.ts` reconstructing `RenderContext` by hand
   * requires it: that's true of every field under `derived` too (see
   * context-from-fixture.ts:24-53), so it does not distinguish `turnCount`.
   *
   * The current value, `9`, is a leftover from before #129 — it was observed
   * under the OLD shard-per-session-id counter, not under `countHumanTurns`,
   * so it is not a recording of what the current derivation produces for
   * this fixture's transcript. Harmless (`context-from-fixture.ts` treats it
   * as a plain input either way), but not provenance to trust. Everything
   * under `derived`, by contrast, IS a real recording and must never be
   * hand-edited.
   */
  controlled: {
    turnCount: number;
  };
}
