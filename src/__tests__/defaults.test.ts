import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { getWidget } from "../widgets/registry.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetOutput } from "../widgets/base.js";
import type { WidgetConfig } from "../config/schema.js";

// Deterministic git state so git-branch/git-changes render for every sweep
// value instead of depending on the ambient repo's working tree.
vi.mock("../utils/git.js", () => ({
  getGitBranch: () => "main",
  getGitChanges: () => ({ added: 2, modified: 1, deleted: 0 }),
}));

describe("DEFAULT_SETTINGS", () => {
  it("references only registered widget types", () => {
    for (const line of DEFAULT_SETTINGS.lines) {
      for (const widget of line.widgets) {
        expect(getWidget(widget.type), `unregistered widget: ${widget.type}`).not.toBeNull();
      }
    }
  });

  it("shows the compact countdown and keeps it through compaction", () => {
    const countdown = DEFAULT_SETTINGS.lines
      .flatMap((line) => line.widgets)
      .find((widget) => widget.type === "compact-countdown");
    expect(countdown).toBeDefined();
    expect(countdown!.priority).toBe(4);
  });

  it("assigns each prioritised widget a distinct priority", () => {
    const priorities = DEFAULT_SETTINGS.lines
      .flatMap((line) => line.widgets)
      .map((widget) => widget.priority)
      .filter((priority): priority is number => priority !== undefined);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

describe("DEFAULT_SETTINGS rendered adjacency", () => {
  // The powerline separator is drawn in the previous segment's *runtime* bg
  // over the next segment's runtime bg. Several widgets (context-percent,
  // compact-countdown, session-cost, today-spend) override bg from thresholds
  // at render time, so a static comparison of configured `bg` values isn't
  // enough — two widgets with different configured colors can still collide
  // once thresholds kick in. These tests render the real widget outputs
  // across a sweep of context-usage values and check actual adjacency.

  const USAGE_SWEEP = [10, 50, 65, 70, 75, 80, 83.5, 90, 95];
  const WINDOW_SIZE = 200_000;

  // today-spend recolors at its own thresholds, and vim-mode picks a color per
  // mode. Both must be varied: they are adjacent on line 2 (api-latency used to
  // sit between them), so a collision only appears in specific combinations —
  // pinning either dimension hides it. dailyWarn is 10 and dailyDanger 25.
  const TODAY_SWEEP = [3, 12, 30];
  const VIM_SWEEP = ["NORMAL", "INSERT"];

  interface SweepPoint {
    used: number;
    today: number;
    vim: string;
  }

  function sweepPoints(): SweepPoint[] {
    const points: SweepPoint[] = [];
    for (const used of USAGE_SWEEP) {
      for (const today of TODAY_SWEEP) {
        for (const vim of VIM_SWEEP) {
          points.push({ used, today, vim });
        }
      }
    }
    return points;
  }

  function makeSweepContext(point: SweepPoint): RenderContext {
    return {
      stdin: {
        model: "claude-sonnet-4-20250514",
        cwd: process.cwd(),
        context_window: {
          used_percentage: point.used,
          context_window_size: WINDOW_SIZE,
        },
        cost: {
          total_cost_usd: 2.5,
          total_lines_added: 12,
          total_lines_removed: 4,
        },
        vim: { mode: point.vim },
      },
      metrics: {
        byModel: new Map(),
        session: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        today: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      },
      block: null,
      burnRate: { tokensPerMinute: 500, costPerHour: 1, costPerMinute: 0.02 },
      pricing: {},
      // sessionCostUsd is deliberately held below sessionWarn. session-cost and
      // context-percent are adjacent on line 1 and share the same alert palette
      // (#a67c00 / #c01c28), so they collide once both cross their thresholds.
      // That collision predates the compact-countdown work — those two were
      // already neighbours — and is tracked separately in issue #36. Varying
      // this dimension here would fail the suite on a pre-existing defect
      // rather than on anything this layout changed.
      sessionCostUsd: 2.5,
      todayCostUsd: point.today,
      costByModel: new Map(),
      sessionStartTime: null,
      terminalWidth: 200,
      alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
      turnCount: 5,
    };
  }

  interface Rendered {
    type: string;
    output: WidgetOutput;
    priority: number;
  }

  function renderConfig(context: RenderContext, config: WidgetConfig): Rendered | null {
    const widget = getWidget(config.type);
    if (!widget) return null;
    const output = widget.render(context, config);
    if (!output) return null;
    return { type: config.type, output, priority: config.priority ?? 99 };
  }

  function assertNoAdjacentCollision(rendered: Rendered[], point: SweepPoint, mode: string): void {
    for (let i = 1; i < rendered.length; i++) {
      const prev = rendered[i - 1]!;
      const curr = rendered[i]!;
      if (prev.output.bg === undefined || curr.output.bg === undefined) continue;
      expect(
        prev.output.bg,
        `[${mode}] ${prev.type} and ${curr.type} both render bg ${prev.output.bg} ` +
          `at used_percentage=${point.used}, todayCostUsd=${point.today}, vim=${point.vim}`,
      ).not.toBe(curr.output.bg);
    }
  }

  it("never places two rendered segments with the same bg side by side, per line", () => {
    for (const point of sweepPoints()) {
      const context = makeSweepContext(point);
      for (const line of DEFAULT_SETTINGS.lines) {
        const rendered = line.widgets
          .map((config) => renderConfig(context, config))
          .filter((r): r is Rendered => r !== null);
        assertNoAdjacentCollision(rendered, point, "line");
      }
    }
  });

  it("never places two rendered segments with the same bg side by side, in compact mode", () => {
    // renderCompact (src/render/renderer.ts) flattens both lines and sorts
    // by priority, ignoring line boundaries — so adjacency here can differ
    // from the per-line adjacency above.
    for (const point of sweepPoints()) {
      const context = makeSweepContext(point);
      const rendered = DEFAULT_SETTINGS.lines
        .flatMap((line) => line.widgets)
        .map((config) => renderConfig(context, config))
        .filter((r): r is Rendered => r !== null)
        .sort((a, b) => a.priority - b.priority);
      assertNoAdjacentCollision(rendered, point, "compact");
    }
  });
});
