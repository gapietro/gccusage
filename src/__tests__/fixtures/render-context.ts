import type { RenderContext } from "../../types/render-context.js";

/**
 * A minimal in-process `RenderContext`: no tokens, no cost, nothing uncertain,
 * a 120-column terminal. Shared so a new `RenderContext` field is added in one
 * place rather than in each widget test's private copy (TEST-004).
 *
 * `overrides` is a shallow spread, so passing `stdin` or `metrics` replaces the
 * whole object rather than merging into it. Every call builds fresh Maps and
 * arrays, so a test that mutates its context cannot leak into the next.
 */
export function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    stdin: { model: "claude-sonnet-4-20250514" },
    metrics: {
      byModel: new Map(),
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      },
    },
    block: null,
    burnRate: null,
    burnRateUncertain: false,
    pricing: {},
    sessionCostUsd: 0,
    todayCostUsd: 0,
    costByModel: new Map(),
    unpricedModels: [],
    approximatedModels: [],
    sessionCostUncertain: false,
    todayCostUncertain: false,
    sessionStartTime: null,
    terminalWidth: 120,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: 0,
    ...overrides,
  };
}
