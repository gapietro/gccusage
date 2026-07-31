import { describe, it, expect } from "vitest";
import type { RenderContext } from "../types/render-context.js";
import { modelWidget } from "../widgets/model.js";
import { sessionCostWidget } from "../widgets/session-cost.js";
import { contextPercentWidget } from "../widgets/context-percent.js";
import { separatorWidget } from "../widgets/separator.js";
import { todaySpendWidget } from "../widgets/today-spend.js";
import { blockTimerWidget } from "../widgets/block-timer.js";
import { compactCountdownWidget } from "../widgets/compact-countdown.js";

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    stdin: { model: "claude-sonnet-4-20250514" },
    metrics: {
      byModel: new Map(),
      session: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      today: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    },
    block: null,
    burnRate: null,
    pricing: {},
    sessionCostUsd: 0,
    todayCostUsd: 0,
    costByModel: new Map(),
    sessionStartTime: null,
    terminalWidth: 120,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: 0,
    ...overrides,
  };
}

describe("modelWidget", () => {
  it("renders model name", () => {
    const result = modelWidget.render(makeContext(), { type: "model" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Sonnet 4");
  });

  it("returns null when no model", () => {
    const result = modelWidget.render(makeContext({ stdin: {} }), { type: "model" });
    expect(result).toBeNull();
  });

  it("includes label and icon", () => {
    const result = modelWidget.render(makeContext(), {
      type: "model",
      label: "Model:",
      icon: "🤖",
    });
    expect(result!.text).toBe("🤖 Model: Sonnet 4");
  });
});

describe("sessionCostWidget", () => {
  it("renders session cost", () => {
    const result = sessionCostWidget.render(
      makeContext({ sessionCostUsd: 2.45 }),
      { type: "session-cost" },
    );
    expect(result!.text).toBe("$2.45");
  });
});

describe("contextPercentWidget", () => {
  it("renders context percentage", () => {
    const ctx = makeContext({
      stdin: {
        model: "claude-sonnet-4-20250514",
        token_usage: {
          input_tokens: 45000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        context_window: 200000,
      },
    });
    const result = contextPercentWidget.render(ctx, { type: "context-percent" });
    expect(result!.text).toBe("[===-------] 25% (200.0k)");
  });

  it("returns null when no context window", () => {
    const result = contextPercentWidget.render(makeContext(), { type: "context-percent" });
    expect(result).toBeNull();
  });

  it("renders with the size suffix when used_percentage comes with a window size", () => {
    const ctx = makeContext({
      stdin: {
        context_window: { used_percentage: 25, context_window_size: 200_000 },
      },
    });
    const result = contextPercentWidget.render(ctx, { type: "context-percent" });
    expect(result!.text).toBe("[===-------] 25% (200.0k)");
  });

  it("renders without a size suffix when used_percentage has no window size", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 25 } },
    });
    const result = contextPercentWidget.render(ctx, { type: "context-percent" });
    expect(result!.text).toBe("[===-------] 25%");
  });
});

describe("separatorWidget", () => {
  it("renders default separator", () => {
    const result = separatorWidget.render(makeContext(), { type: "separator" });
    expect(result!.text).toBe(" | ");
  });

  it("renders custom separator", () => {
    const result = separatorWidget.render(makeContext(), {
      type: "separator",
      separator: " :: ",
    });
    expect(result!.text).toBe(" :: ");
  });
});

describe("todaySpendWidget", () => {
  it("renders today's spend", () => {
    const result = todaySpendWidget.render(
      makeContext({ todayCostUsd: 18.72 }),
      { type: "today-spend" },
    );
    expect(result!.text).toBe("Today: $18.72");
  });
});

describe("blockTimerWidget", () => {
  it("renders block timer", () => {
    const result = blockTimerWidget.render(
      makeContext({
        block: {
          blockStartTime: Date.now() - 12120000,
          elapsedMs: 12120000,
          remainingMs: 5880000,
          blockDurationMs: 18000000,
        },
      }),
      { type: "block-timer" },
    );
    expect(result!.text).toBe("Block: 3hr 22m");
  });

  it("returns null when no block", () => {
    const result = blockTimerWidget.render(makeContext(), { type: "block-timer" });
    expect(result).toBeNull();
  });
});

describe("compactCountdownWidget", () => {
  it("reports real headroom on a long session with a mostly-empty context", () => {
    // Regression: total_input/output_tokens are cumulative and dwarf the window.
    // Reading them as current usage pinned this widget to "Compact imminent!".
    const ctx = makeContext({
      stdin: {
        context_window: {
          remaining_percentage: 93,
          context_window_size: 1_000_000,
          total_input_tokens: 2_600_000,
          total_output_tokens: 90_000,
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    // 7% of 1M is 70k used; the threshold is 967k, so 897k remains. The old
    // 83.5% constant put the threshold at 835k and reported 765k.
    expect(result!.text).toBe("~897.0k left");
  });

  it("derives headroom from used_percentage", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 25, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~117.0k left");
  });

  it("derives headroom from current_usage", () => {
    const ctx = makeContext({
      stdin: {
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 30_000,
            output_tokens: 5_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~117.0k left");
  });

  it("supports the legacy numeric context window", () => {
    const ctx = makeContext({
      stdin: {
        context_window: 200_000,
        token_usage: {
          input_tokens: 45_000,
          output_tokens: 5_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~117.0k left");
  });

  it("keeps the configured background when there is plenty of headroom", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 25, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.bg).toBe("#1a5fb4");
  });

  it("turns amber exactly 20k before the threshold", () => {
    // 73.5% of 200k is 147k used; the threshold is 167k, so 20k remains —
    // Claude Code's own warn level, and the boundary is inclusive.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 73.5, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~20.0k left");
    expect(result!.bg).toBe("#b8860b");
  });

  it("keeps the configured background just outside the amber band", () => {
    // 70% of 200k is 140k used, leaving 27k — comfortably above the band.
    // The old fraction-based rule called this amber.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 70, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~27.0k left");
    expect(result!.bg).toBe("#1a5fb4");
  });

  it("turns red exactly 5k before the threshold", () => {
    // 81% of 200k is 162k used, leaving 5k. Inclusive boundary.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 81, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~5.0k left");
    expect(result!.bg).toBe("#a01822");
  });

  it("is amber, not red, at 7k remaining", () => {
    // 80% of 200k is 160k used, leaving 7k — inside amber, outside red.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 80, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~7.0k left");
    expect(result!.bg).toBe("#b8860b");
  });

  it("announces an imminent compact at the threshold", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 83.5, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("Compact imminent!");
    expect(result!.bg).toBe("#a01822");
  });

  it("announces an imminent compact past the threshold", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 90, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("Compact imminent!");
  });

  it("reports full headroom for a brand-new session with 0% usage", () => {
    // Pre-fix behavior guarded `usedTokens === 0` and returned null here.
    // Zero usage is a real, renderable state: full headroom to the threshold.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 0, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("~167.0k left");
  });

  it("returns null without a context window", () => {
    const result = compactCountdownWidget.render(makeContext(), { type: "compact-countdown" });
    expect(result).toBeNull();
  });

  it("returns null when the window size is unknown", () => {
    // A ratio alone cannot be converted into a token count.
    const ctx = makeContext({ stdin: { context_window: { used_percentage: 25 } } });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result).toBeNull();
  });

  it("scales the bands to a 1M window instead of a fixed fraction", () => {
    // 94.7% of 1M is 947k used, leaving 20k — amber. Under the old rule this
    // was long past "Compact imminent!", 112k tokens too early.
    const amber = compactCountdownWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 94.7, context_window_size: 1_000_000 } },
      }),
      { type: "compact-countdown", bg: "#1a5fb4" },
    );
    expect(amber!.text).toBe("~20.0k left");
    expect(amber!.bg).toBe("#b8860b");

    const imminent = compactCountdownWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 96.7, context_window_size: 1_000_000 } },
      }),
      { type: "compact-countdown", bg: "#1a5fb4" },
    );
    expect(imminent!.text).toBe("Compact imminent!");
  });
});
