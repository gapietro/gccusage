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
   * Deliberately chosen test inputs, NOT recordings. `turnCount` lives here,
   * separate from `derived`, because `src/data/turn-tracker.ts`'s
   * `trackTurn()` is now sharded per session id (`<cacheDir>/turns/<shardKey
   * (sessionId)>.json`, #99) rather than a single global file — but that
   * does not make a recorded value meaningful. Generating fixtures for three
   * different session ids in one process creates a *fresh* shard per session
   * id, and a fresh shard always starts at count 1: a "recorded" turnCount
   * would still only encode generation order (which fixture ran first),
   * never anything resembling a real session's accumulated turn count.
   * Everything under `derived`, by contrast, IS a real recording and must
   * never be hand-edited.
   */
  controlled: {
    turnCount: number;
  };
}
