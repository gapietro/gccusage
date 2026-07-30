import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { getWidget } from "../widgets/registry.js";
import { layoutPowerline } from "../render/powerline.js";
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
  // Several widgets (context-percent, compact-countdown, session-cost,
  // today-spend, vim-mode) override bg from thresholds at render time, so a
  // static comparison of configured colors proves nothing. These tests render
  // the real widget outputs across a cross product of every threshold
  // dimension, push them through the renderer's own styling pass, and assert
  // nothing comes out invisible.

  const USAGE_SWEEP = [10, 50, 65, 70, 75, 80, 83.5, 90, 95];
  const WINDOW_SIZE = 200_000;

  // Every widget in the default layout that recolors itself from a threshold
  // gets its own axis. Pinning any one of them hides collisions that only
  // appear in specific combinations — that blind spot is what issue #36 was
  // filed about. sessionWarn 5 / sessionDanger 15, dailyWarn 10 /
  // dailyDanger 25, and vim-mode picks a color per mode.
  const SESSION_SWEEP = [2.5, 8, 20];
  const TODAY_SWEEP = [3, 12, 30];
  const VIM_SWEEP = ["NORMAL", "INSERT"];

  interface SweepPoint {
    used: number;
    session: number;
    today: number;
    vim: string;
  }

  function sweepPoints(): SweepPoint[] {
    const points: SweepPoint[] = [];
    for (const used of USAGE_SWEEP) {
      for (const session of SESSION_SWEEP) {
        for (const today of TODAY_SWEEP) {
          for (const vim of VIM_SWEEP) {
            points.push({ used, session, today, vim });
          }
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
      sessionCostUsd: point.session,
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

  const POWERLINE_OPTIONS = {
    theme: DEFAULT_SETTINGS.powerline.theme,
    separator: DEFAULT_SETTINGS.powerline.separator,
    separatorThin: DEFAULT_SETTINGS.powerline.separatorThin,
  };

  // The renderer paints separators and segment text from the same resolved
  // {fg, bg} model, so one predicate covers both: a piece whose fg matches its
  // own bg is invisible — an unreadable segment, or a seam that makes two
  // segments read as one block.
  function assertEveryPieceVisible(rendered: Rendered[], point: SweepPoint, mode: string): void {
    const pieces = layoutPowerline(
      rendered.map((r) => r.output),
      POWERLINE_OPTIONS,
    );
    const order = rendered.map((r) => r.type).join(" > ");
    for (const piece of pieces) {
      if (piece.bg === undefined) continue;
      expect(
        piece.fg.toLowerCase(),
        `[${mode}] "${piece.text}" is invisible (fg === bg === ${piece.bg}) at ` +
          `used_percentage=${point.used}, sessionCostUsd=${point.session}, ` +
          `todayCostUsd=${point.today}, vim=${point.vim}. Segments: ${order}`,
      ).not.toBe(piece.bg.toLowerCase());
    }
  }

  it("never renders an invisible piece (fg === bg), per line", () => {
    for (const point of sweepPoints()) {
      const context = makeSweepContext(point);
      for (const line of DEFAULT_SETTINGS.lines) {
        const rendered = line.widgets
          .map((config) => renderConfig(context, config))
          .filter((r): r is Rendered => r !== null);
        assertEveryPieceVisible(rendered, point, "line");
      }
    }
  });

  it("never renders an invisible piece (fg === bg), in compact mode", () => {
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
      assertEveryPieceVisible(rendered, point, "compact");
    }
  });
});
