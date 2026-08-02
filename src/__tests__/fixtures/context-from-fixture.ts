import * as v from "valibot";
import { StatusJsonSchema } from "../../types/status-json.js";
import type { RenderContext } from "../../types/render-context.js";
import type { RealPayloadFixture } from "./real-payloads/fixture-types.js";

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
      byModel: new Map(fx.derived.metrics.byModel),
      totals: fx.derived.metrics.session,
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
    sessionCostUncertain: false,
    todayCostUncertain: false,
    sessionStartTime: fx.derived.sessionStartTime,
    terminalWidth: 200,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: fx.controlled.turnCount,
  };
}
