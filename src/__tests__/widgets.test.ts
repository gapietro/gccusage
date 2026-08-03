import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import type { RenderContext } from "../types/render-context.js";
import { cwdWidget } from "../widgets/cwd.js";
import { tokenBreakdownWidget } from "../widgets/token-breakdown.js";
import { tokensInputWidget } from "../widgets/tokens-input.js";
import { tokensOutputWidget } from "../widgets/tokens-output.js";
import { modelWidget } from "../widgets/model.js";
import { sessionCostWidget } from "../widgets/session-cost.js";
import { contextPercentWidget } from "../widgets/context-percent.js";
import { separatorWidget } from "../widgets/separator.js";
import { todaySpendWidget } from "../widgets/today-spend.js";
import { blockTimerWidget } from "../widgets/block-timer.js";
import { compactCountdownWidget } from "../widgets/compact-countdown.js";
import { projectWidget } from "../widgets/project.js";
import { perModelBreakdownWidget } from "../widgets/per-model-breakdown.js";
import { sessionClockWidget } from "../widgets/session-clock.js";
import { sessionTimerWidget } from "../widgets/session-timer.js";
import { getHomeDir } from "../utils/paths.js";
import { tokensUntilCompact } from "../utils/autocompact.js";
import {
  ALERT_AMBER,
  ALERT_RED,
  COMPACT_COUNTDOWN_AMBER,
  COMPACT_COUNTDOWN_RED,
} from "../widgets/alert-colors.js";

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    stdin: { model: "claude-sonnet-4-20250514" },
    metrics: {
      byModel: new Map(),
      totals: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    },
    block: null,
    burnRate: null,
    pricing: {},
    sessionCostUsd: 0,
    todayCostUsd: 0,
    costByModel: new Map(),
    unpricedModels: [],
    sessionCostUncertain: false,
    todayCostUncertain: false,
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

  // A total that silently omits an unpriced model's usage is the failure #82
  // reports: offline, every model went unpriced and the bar rendered a
  // confident "$0.00" no user could distinguish from a free session.
  it("marks a total that omits unpriced usage", () => {
    const result = sessionCostWidget.render(
      makeContext({ sessionCostUsd: 2.45, sessionCostUncertain: true }),
      { type: "session-cost" },
    );
    expect(result!.text).toBe("$2.45?");
  });

  it("marks a zero total that omits unpriced usage", () => {
    const result = sessionCostWidget.render(
      makeContext({ sessionCostUsd: 0, sessionCostUncertain: true }),
      { type: "session-cost" },
    );
    expect(result!.text).toBe("$0.00?");
  });

  it("keeps the marker after a configured label", () => {
    const result = sessionCostWidget.render(
      makeContext({ sessionCostUsd: 2.45, sessionCostUncertain: true }),
      { type: "session-cost", label: "Cost:" },
    );
    expect(result!.text).toBe("Cost: $2.45?");
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

  it("turns amber at Claude Code's warn level, not at 70%", () => {
    // 147k of 200k used leaves 20k before compaction.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 73.5, context_window_size: 200_000 } },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#a67c00");
  });

  it("turns red 5k before compaction, so the red state is reachable", () => {
    // The old 90% danger threshold sat above the 83.5% compaction point at a
    // 200k window, so a session compacted before it could ever turn red.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 81, context_window_size: 200_000 } },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#c01c28");
  });

  it("keeps the configured background at 70% of a 200k window", () => {
    // 140k used leaves 27k — outside both bands under the derived rule.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 70, context_window_size: 200_000 } },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#0d7377");
  });

  it("scales the bands to a 1M window", () => {
    const amber = contextPercentWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 94.7, context_window_size: 1_000_000 } },
      }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(amber!.bg).toBe("#a67c00");

    // 90% of a 1M window is 900k used — 67k of headroom left, no alert.
    const calm = contextPercentWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 90, context_window_size: 1_000_000 } },
      }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(calm!.bg).toBe("#0d7377");
  });

  it("falls back to percentage thresholds when no window size is reported", () => {
    const warn = contextPercentWidget.render(
      makeContext({ stdin: { context_window: { used_percentage: 75 } } }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(warn!.bg).toBe("#a67c00");

    const danger = contextPercentWidget.render(
      makeContext({ stdin: { context_window: { used_percentage: 95 } } }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(danger!.bg).toBe("#c01c28");
  });

  it("turns red from a current_usage breakdown, not just used_percentage", () => {
    // Production payloads carry current_usage, not a synthetic percentage.
    // 162k of 200k used leaves exactly 5k before the 167k threshold.
    const ctx = makeContext({
      stdin: {
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 100_000,
            output_tokens: 2_000,
            cache_creation_input_tokens: 30_000,
            cache_read_input_tokens: 30_000,
          },
        },
      },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#c01c28");
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

  it("marks a total that omits unpriced usage", () => {
    const result = todaySpendWidget.render(
      makeContext({ todayCostUsd: 18.72, todayCostUncertain: true }),
      { type: "today-spend" },
    );
    expect(result!.text).toBe("Today: $18.72?");
  });

  it("is unmarked when only the session total is uncertain", () => {
    // The two totals can come from different sources — a calculated session
    // beside a daily store fed from stdin — so one flag must not leak.
    const result = todaySpendWidget.render(
      makeContext({ todayCostUsd: 18.72, sessionCostUncertain: true }),
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

  it("turns red from a current_usage breakdown, not just used_percentage", () => {
    // Production payloads carry current_usage, not a synthetic percentage.
    // 162k of 200k used leaves exactly 5k before the 167k threshold.
    const ctx = makeContext({
      stdin: {
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 100_000,
            output_tokens: 2_000,
            cache_creation_input_tokens: 30_000,
            cache_read_input_tokens: 30_000,
          },
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~5.0k left");
    expect(result!.bg).toBe("#a01822");
  });
});

describe("projectWidget", () => {
  // The widget resolves home through getHomeDir(), which reads HOME first, so
  // pin it and put it back — src/__tests__/error-line.test.ts uses the same
  // save/restore.
  const originalHome = process.env["HOME"];
  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  function ctx(workspace: unknown, cwd?: string): RenderContext {
    return makeContext({ stdin: { cwd, workspace } as never });
  }

  it("renders the basename of project_dir", () => {
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage" }), {
      type: "project",
    });
    expect(out?.text).toBe("gccusage");
  });

  it("ignores cwd when the session started in a subdirectory (#59)", () => {
    const out = projectWidget.render(
      ctx({ project_dir: "/Users/x/projects/gccusage" }, "/Users/x/projects/gccusage/src/widgets"),
      { type: "project" },
    );
    expect(out?.text).toBe("gccusage");
  });

  it("ignores a trailing slash", () => {
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage/" }), {
      type: "project",
    });
    expect(out?.text).toBe("gccusage");
  });

  it("renders ~ when the project dir is HOME itself", () => {
    process.env["HOME"] = "/Users/x";
    const out = projectWidget.render(ctx({ project_dir: "/Users/x" }), { type: "project" });
    expect(out?.text).toBe("~");
  });

  it("renders / for the filesystem root", () => {
    const out = projectWidget.render(ctx({ project_dir: "/" }), { type: "project" });
    expect(out?.text).toBe("/");
  });

  it("still collapses the resolved home to ~ when HOME is unset (#69)", () => {
    // getHomeDir() falls back to the passwd entry, so an unset HOME no longer
    // means "no home to compare against". Asserting against getHomeDir() is
    // what distinguishes the two implementations: reading process.env.HOME
    // directly renders the basename here instead.
    delete process.env["HOME"];
    const out = projectWidget.render(ctx({ project_dir: getHomeDir() }), { type: "project" });
    expect(out?.text).toBe("~");
  });

  it("renders the basename for a project dir outside home when HOME is unset", () => {
    delete process.env["HOME"];
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage" }), {
      type: "project",
    });
    expect(out?.text).toBe("gccusage");
  });

  it("declines when workspace is absent rather than falling back to cwd", () => {
    // A cwd fallback would be right whenever the session started at the repo
    // root and silently wrong whenever it did not — the #59 defect with no
    // signal that it fired. Fail closed instead.
    const out = projectWidget.render(ctx(undefined, "/Users/x/projects/gccusage/src/widgets"), {
      type: "project",
    });
    expect(out).toBeNull();
  });

  it("declines when project_dir is an empty string", () => {
    const out = projectWidget.render(ctx({ project_dir: "" }), { type: "project" });
    expect(out).toBeNull();
  });

  it("prefixes a configured label", () => {
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage" }), {
      type: "project",
      label: "proj",
    });
    expect(out?.text).toBe("proj gccusage");
  });
});

describe("tokenBreakdownWidget", () => {
  // The real numbers from the 2.1.220 payload in #58: context_window's totals
  // are a last-assistant-message snapshot, the session really billed 122 in
  // and 37,659 out. Both are present here so the assertion distinguishes the
  // two sources rather than passing on whichever one is wired up.
  function ctx(session: Partial<RenderContext["metrics"]["totals"]>): RenderContext {
    return makeContext({
      stdin: {
        context_window: { total_input_tokens: 115847, total_output_tokens: 2 },
      } as never,
      metrics: {
        byModel: new Map(),
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          ...session,
        },
      },
    });
  }

  it("reads session totals, not the context_window snapshot (#58)", () => {
    const context = ctx({ inputTokens: 122, outputTokens: 37659 });
    const out = tokenBreakdownWidget.render(context, { type: "token-breakdown" });
    expect(out?.text).toBe("In:122 Out:37.7k");
  });

  it("agrees with tokens-input and tokens-output about the same session (#58)", () => {
    // The defect's visible symptom was three widgets on one bar reporting
    // different numbers for one session.
    const context = ctx({ inputTokens: 122, outputTokens: 37659 });
    const breakdown = tokenBreakdownWidget.render(context, { type: "token-breakdown" })!.text;
    const input = tokensInputWidget.render(context, { type: "tokens-input" })!.text;
    const output = tokensOutputWidget.render(context, { type: "tokens-output" })!.text;
    expect(breakdown).toBe(`In:${input.replace("In: ", "")} Out:${output.replace("Out: ", "")}`);
  });

  it("renders without a context_window block at all", () => {
    const context = makeContext({
      stdin: {} as never,
      metrics: {
        byModel: new Map(),
        totals: {
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      },
    });
    expect(tokenBreakdownWidget.render(context, { type: "token-breakdown" })?.text).toBe(
      "In:10 Out:20",
    );
  });

  it("declines when nothing has been measured", () => {
    expect(tokenBreakdownWidget.render(ctx({}), { type: "token-breakdown" })).toBeNull();
  });
});

describe("cwdWidget", () => {
  const originalHome = process.env["HOME"];
  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  function ctx(cwd?: string): RenderContext {
    return makeContext({ stdin: { cwd } as never });
  }

  it("abbreviates the home prefix to ~", () => {
    process.env["HOME"] = "/Users/x";
    expect(cwdWidget.render(ctx("/Users/x/projects/gccusage"), { type: "cwd" })?.text).toBe(
      "~/projects/gccusage",
    );
  });

  it("leaves a path outside home alone", () => {
    process.env["HOME"] = "/Users/x";
    expect(cwdWidget.render(ctx("/opt/src"), { type: "cwd" })?.text).toBe("/opt/src");
  });

  it("still abbreviates the resolved home when HOME is unset (#69)", () => {
    // Same distinguishing assertion as projectWidget's: reading
    // process.env.HOME directly leaves the path unabbreviated here.
    delete process.env["HOME"];
    const out = cwdWidget.render(ctx(path.join(getHomeDir(), "projects")), { type: "cwd" });
    expect(out?.text).toBe("~/projects");
  });

  it("declines without a cwd", () => {
    expect(cwdWidget.render(ctx(undefined), { type: "cwd" })).toBeNull();
  });
});

describe("perModelBreakdownWidget", () => {
  const context = (models: Record<string, number>) =>
    makeContext({ costByModel: new Map(Object.entries(models)) });

  // The exact collision #63 described. The old abbreviation took the first
  // letter of each space-separated word of formatModelName's output, so the
  // minor version — which is not its own word — was dropped: "Sonnet 4.5" and
  // "Sonnet 4" both became "S4", two segments labelled identically in the one
  // widget whose job is telling models apart. Asserting the two labels differ
  // rather than just checking the full strings is what pins the defect: a
  // future re-shortening that collides again fails here.
  it("keeps two versions of one model family distinct (#63)", () => {
    const out = perModelBreakdownWidget.render(
      context({ "claude-sonnet-4-20250514": 1.2, "claude-sonnet-4-5-20250929": 3.4 }),
      { type: "per-model" },
    );
    expect(out?.text).toBe("Sonnet 4:$1.20 Sonnet 4.5:$3.40");

    const labels = [...out!.text.matchAll(/([^:]+):\$[\d.]+/g)].map((m) => m[1]!.trim());
    expect(labels, "expected one label per model").toHaveLength(2);
    expect(new Set(labels).size, `labels collided: ${labels.join(", ")}`).toBe(labels.length);
  });

  it("renders an unrecognised model id verbatim rather than as an initial", () => {
    // formatModelName returns the raw id when its pattern misses. The old
    // abbreviation reduced that whole id to one letter.
    const out = perModelBreakdownWidget.render(context({ "some-custom-model": 0.5 }), {
      type: "per-model",
    });
    expect(out?.text).toBe("some-custom-model:$0.50");
  });

  it("declines when no per-model cost is known", () => {
    expect(perModelBreakdownWidget.render(context({}), { type: "per-model" })).toBeNull();
  });

  // This widget renders straight off the pricing table, so an unpriced model
  // vanished from the one display whose entire job is naming which models ran.
  it("names a model it could not price", () => {
    const out = perModelBreakdownWidget.render(
      makeContext({
        costByModel: new Map([["claude-opus-5", 22.52]]),
        unpricedModels: ["claude-fable-5"],
      }),
      { type: "per-model" },
    );
    expect(out?.text).toBe("Opus 5:$22.52 Fable 5:$?");
  });

  it("renders when every model went unpriced", () => {
    // costByModel is empty here, which used to mean "decline" — so an
    // all-unpriced render showed nothing at all rather than showing why.
    const out = perModelBreakdownWidget.render(
      makeContext({ costByModel: new Map(), unpricedModels: ["claude-fable-5"] }),
      { type: "per-model" },
    );
    expect(out?.text).toBe("Fable 5:$?");
  });
});

describe("session duration widgets (#61)", () => {
  // session-clock measures from the transcript's first entry (survives
  // --resume); session-timer measures cost.total_duration_ms, which Claude
  // Code computes from the CLI *process* start time (resets on restart).
  // Before this, both rendered a bare duration, so the two different
  // quantities were indistinguishable on the bar.
  it("labels the two clocks distinctly by default", () => {
    const now = Date.now();
    const clock = sessionClockWidget.render(
      makeContext({ sessionStartTime: now - 3_600_000 }),
      { type: "session-clock" },
    );
    const timer = sessionTimerWidget.render(
      makeContext({ stdin: { cost: { total_duration_ms: 3_600_000 } } as never }),
      { type: "session-timer" },
    );

    expect(clock?.text).toBe("Session: 1hr 0m");
    expect(timer?.text).toBe("Up: 1hr 0m");
  });

  it("still allows opting out of the label with an empty string", () => {
    const out = sessionClockWidget.render(makeContext({ sessionStartTime: Date.now() - 3_600_000 }), {
      type: "session-clock",
      label: "",
    });
    expect(out?.text).toBe("1hr 0m");
  });
});

// #46. Every pre-existing band test drove these widgets with a FRACTIONAL
// used_percentage (73.5, 81, 94.7). Those exercise the arithmetic but cannot
// occur in a real payload — Claude Code rounds the field — so none of them
// showed whether a band is reachable in production. These sweep whole-number
// percentages, which is the only kind that ships.
describe("alert bands are reachable from real payloads (#46)", () => {
  const at = (pct: number, windowSize: number) =>
    makeContext({
      stdin: { context_window: { used_percentage: pct, context_window_size: windowSize } },
    });

  // Percentages strictly BEFORE the compaction point. Past it, compact-countdown
  // renders "Compact imminent!" in red and context-percent reports zero
  // remaining, so both show red no matter how the bands are set — sweeping
  // those in would make "red was seen" true even with the bug present. This
  // asks the question that matters: does red ever appear as a WARNING?
  const bandsSeen = (windowSize: number) => {
    const countdown = new Set<string | undefined>();
    const percent = new Set<string | undefined>();
    let swept = 0;
    for (let pct = 0; pct <= 100; pct++) {
      const remaining = tokensUntilCompact((pct / 100) * windowSize, windowSize);
      if (remaining === null || remaining <= 0) continue;
      swept++;
      const ctx = at(pct, windowSize);
      countdown.add(
        compactCountdownWidget.render(ctx, { type: "compact-countdown", bg: "#1a5fb4" })?.bg,
      );
      percent.add(
        contextPercentWidget.render(ctx, { type: "context-percent", bg: "#0d7377" })?.bg,
      );
    }
    expect(swept, "no pre-compaction percentages swept").toBeGreaterThan(50);
    return { countdown, percent };
  };

  it("reaches red on both widgets at a 1M window", () => {
    const { countdown, percent } = bandsSeen(1_000_000);
    expect(countdown.has(COMPACT_COUNTDOWN_RED), "compact-countdown never turned red").toBe(true);
    expect(countdown.has(COMPACT_COUNTDOWN_AMBER), "compact-countdown never turned amber").toBe(
      true,
    );
    expect(percent.has(ALERT_RED), "context-percent never turned red").toBe(true);
    expect(percent.has(ALERT_AMBER), "context-percent never turned amber").toBe(true);
  });

  it("reaches red on both widgets at a 200k window", () => {
    const { countdown, percent } = bandsSeen(200_000);
    expect(countdown.has(COMPACT_COUNTDOWN_RED)).toBe(true);
    expect(percent.has(ALERT_RED)).toBe(true);
  });

  // The property PR #45 was built around: the two segments must never
  // contradict each other, which widening one band without the other would
  // break. Checked across the whole sweep, not at one hand-picked percentage.
  it("keeps the two widgets in agreement at every whole percentage", () => {
    for (const windowSize of [200_000, 1_000_000]) {
      for (let pct = 0; pct <= 100; pct++) {
        const ctx = at(pct, windowSize);
        const cd = compactCountdownWidget.render(ctx, {
          type: "compact-countdown",
          bg: "#1a5fb4",
        });
        const cp = contextPercentWidget.render(ctx, {
          type: "context-percent",
          bg: "#0d7377",
        });
        const cdLevel =
          cd?.bg === COMPACT_COUNTDOWN_RED ? "red" : cd?.bg === COMPACT_COUNTDOWN_AMBER ? "amber" : "none";
        const cpLevel = cp?.bg === ALERT_RED ? "red" : cp?.bg === ALERT_AMBER ? "amber" : "none";
        expect(cdLevel, `disagreement at ${pct}% of ${windowSize}`).toBe(cpLevel);
      }
    }
  });

  it("still uses the tight 5k red band when an exact breakdown is present", () => {
    // 962k of 1M leaves exactly 5k. With current_usage the count is exact, so
    // the band must NOT widen — the fix is scoped to coarse input only.
    const exact = (used: number) =>
      makeContext({
        stdin: {
          context_window: {
            context_window_size: 1_000_000,
            current_usage: {
              input_tokens: used,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      });

    expect(
      compactCountdownWidget.render(exact(962_000), { type: "compact-countdown", bg: "#1a5fb4" })
        ?.bg,
    ).toBe(COMPACT_COUNTDOWN_RED);
    // 6k left — inside the widened band, outside the exact one.
    expect(
      compactCountdownWidget.render(exact(961_000), { type: "compact-countdown", bg: "#1a5fb4" })
        ?.bg,
    ).toBe(COMPACT_COUNTDOWN_AMBER);
  });
});
