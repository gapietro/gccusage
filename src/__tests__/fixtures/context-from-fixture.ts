import * as v from "valibot";
import { StatusJsonSchema } from "../../types/status-json.js";
import type { RenderContext } from "../../types/render-context.js";
import type { TokenMetrics } from "../../types/token-metrics.js";
import type { RealPayloadFixture } from "./real-payloads/fixture-types.js";

// `cacheCreation1hTokens` (#118) postdates every recorded fixture, so none of
// them carry it — regenerating to backfill a value would assert an unverified
// fact about those sessions rather than record what actually happened. This
// defaults it to 0 instead, the same "not invented" stance the rest of this
// file already takes for the recording/live-type gap. Key order matters: the
// default must come FIRST so a future regenerated fixture's real value wins
// over it via the spread.
const withTtlSplit = <T extends object>(m: T): T & { cacheCreation1hTokens: number } => ({
  cacheCreation1hTokens: 0,
  ...m,
});

/** Rebuild a RenderContext from a fixture's recorded derived values. */
export function contextFromFixture(fx: RealPayloadFixture, homeDir: string): RenderContext {
  const stdinRaw = JSON.parse(
    JSON.stringify(fx.stdin).split(fx.homePlaceholder).join(homeDir),
  );
  return {
    stdin: v.parse(StatusJsonSchema, stdinRaw),
    // The fixture recorded `session`; the live type calls it `totals`. The
    // recorded `today` has no counterpart — the render path no longer computes
    // it (#94) — so it is deliberately dropped here.
    metrics: {
      byModel: new Map(
        fx.derived.metrics.byModel.map(
          ([model, metrics]) => [model, withTtlSplit(metrics)] as [string, TokenMetrics],
        ),
      ),
      totals: withTtlSplit(fx.derived.metrics.session),
    },
    block: fx.derived.block,
    burnRate: fx.derived.burnRate,
    pricing: {},
    sessionCostUsd: fx.derived.sessionCostUsd,
    todayCostUsd: fx.derived.todayCostUsd,
    costByModel: new Map(fx.derived.costByModel),
    // Every captured payload priced cleanly, so the marked-uncertain rendering
    // is pinned in widgets.test.ts rather than here.
    unpricedModels: [],
    approximatedModels: [],
    sessionCostUncertain: false,
    todayCostUncertain: false,
    sessionStartTime: fx.derived.sessionStartTime,
    terminalWidth: 200,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: fx.controlled.turnCount,
  };
}
