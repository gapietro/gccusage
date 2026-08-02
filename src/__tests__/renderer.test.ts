import { rmSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderStatusline } from "../render/renderer.js";
import { layoutPowerline } from "../render/powerline.js";
import type { RenderContext } from "../types/render-context.js";
import type { Settings } from "../config/schema.js";
import { stripAnsi, visibleLength } from "../utils/terminal.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { makeDeterministicGitRepo } from "./fixtures/git-repo-fixture.js";

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    stdin: {
      model: "claude-sonnet-4-20250514",
      cost: { total_cost_usd: 2.45 },
    },
    metrics: {
      byModel: new Map(),
      session: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      today: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    },
    block: null,
    burnRate: null,
    pricing: {},
    sessionCostUsd: 2.45,
    todayCostUsd: 18.72,
    costByModel: new Map(),
    unpricedModels: [],
    sessionCostUncertain: false,
    todayCostUncertain: false,
    sessionStartTime: null,
    terminalWidth: 80,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: 0,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    lines: [],
    powerline: { enabled: false, theme: "default", separator: "▶", separatorThin: "│" },
    compact: { mode: "auto", threshold: 80 },
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    cache: { statuslineTtlMs: 5000, pricingTtlMs: 86400000 },
    costSource: "auto",
    ...overrides,
  };
}

describe("renderStatusline", () => {
  it("renders a simple single-line config", () => {
    const settings = makeSettings({
      lines: [
        {
          widgets: [
            { type: "model" },
            { type: "separator" },
            { type: "session-cost" },
          ],
          flex: "left",
        },
      ],
    });

    const output = renderStatusline(makeContext(), settings);
    const plain = stripAnsi(output);
    expect(plain).toContain("Sonnet 4");
    expect(plain).toContain("$2.45");
    expect(plain).toContain("|");
  });

  it("skips lines with no output", () => {
    const settings = makeSettings({
      lines: [
        {
          widgets: [{ type: "block-timer" }],
          flex: "left",
        },
      ],
    });

    const output = renderStatusline(makeContext(), settings);
    expect(output).toBe("");
  });

  it("cleans leading/trailing separators", () => {
    const settings = makeSettings({
      lines: [
        {
          widgets: [
            { type: "separator" },
            { type: "model" },
            { type: "separator" },
          ],
          flex: "left",
        },
      ],
    });

    const output = renderStatusline(makeContext(), settings);
    const plain = stripAnsi(output);
    // Should not start or end with separator
    expect(plain.trimEnd().startsWith("|")).toBe(false);
  });

  it("compact mode collapses to single line with priority ordering", () => {
    const settings = makeSettings({
      lines: [
        {
          widgets: [
            { type: "model", priority: 1 },
            { type: "session-cost", priority: 2 },
          ],
          flex: "left",
        },
        {
          widgets: [
            { type: "today-spend", priority: 3 },
          ],
          flex: "left",
        },
      ],
      compact: { mode: "always", threshold: 80 },
      powerline: { enabled: true, theme: "default", separator: "\u25B6", separatorThin: "\u2502" },
    });

    const output = renderStatusline(makeContext(), settings);
    // Should be a single line (no newlines)
    expect(output.split("\n")).toHaveLength(1);
    const plain = stripAnsi(output);
    expect(plain).toContain("Sonnet 4");
    expect(plain).toContain("$2.45");
  });

  it("compact auto mode triggers on narrow terminal", () => {
    const settings = makeSettings({
      lines: [
        {
          widgets: [
            { type: "model", priority: 1 },
            { type: "session-cost", priority: 2 },
          ],
          flex: "left",
        },
        {
          widgets: [
            { type: "today-spend", priority: 3 },
          ],
          flex: "left",
        },
      ],
      compact: { mode: "auto", threshold: 80 },
    });

    // Wide terminal — should be multi-line
    const wide = renderStatusline(makeContext({ terminalWidth: 120 }), settings);
    expect(wide.split("\n").length).toBeGreaterThanOrEqual(2);

    // Narrow terminal — should be single-line
    const narrow = renderStatusline(makeContext({ terminalWidth: 60 }), settings);
    expect(narrow.split("\n")).toHaveLength(1);
  });
});

describe("layoutPowerline", () => {
  const OPTIONS = { theme: "default", separator: "▶", separatorThin: "│" };

  it("draws the wide separator in the previous bg when backgrounds differ", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "#26a269" },
        { text: "b", fg: "#ffffff", bg: "#0d7377" },
      ],
      OPTIONS,
    );
    expect(pieces[1]).toEqual({ text: "▶", fg: "#26a269", bg: "#0d7377" });
  });

  it("draws the thin separator in the previous fg when backgrounds match", () => {
    // session-cost and context-percent both amber: the wide glyph would be
    // painted #a67c00 on #a67c00 and vanish. This is issue #36.
    const pieces = layoutPowerline(
      [
        { text: "$14.21", fg: "#ffffff", bg: "#a67c00" },
        { text: "70%", fg: "#ffffff", bg: "#a67c00" },
      ],
      OPTIONS,
    );
    expect(pieces[1]).toEqual({ text: "│", fg: "#ffffff", bg: "#a67c00" });
  });

  it("compares backgrounds case-insensitively", () => {
    // A hand-written settings.json may use uppercase hex for the same color.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "#A67C00" },
        { text: "b", fg: "#ffffff", bg: "#a67c00" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  it("emits no inner separator for a single segment", () => {
    const pieces = layoutPowerline([{ text: "solo", fg: "#ffffff", bg: "#1a5fb4" }], OPTIONS);
    expect(pieces).toEqual([
      { text: " solo ", fg: "#ffffff", bg: "#1a5fb4" },
      { text: "▶", fg: "#1a5fb4" },
    ]);
  });

  it("returns nothing for no outputs", () => {
    expect(layoutPowerline([], OPTIONS)).toEqual([]);
  });

  it("falls back to the theme palette when a widget sets no colors", () => {
    const pieces = layoutPowerline([{ text: "a" }, { text: "b" }], OPTIONS);
    expect(pieces[0]).toEqual({ text: " a ", fg: "#ffffff", bg: "#5f5faf" });
    expect(pieces[2]).toEqual({ text: " b ", fg: "#ffffff", bg: "#444444" });
  });

  it("draws the thin separator for #fff vs #ffffff (same paint, different strings)", () => {
    // chalk.bgHex("#fff") and chalk.bgHex("#ffffff") both paint
    // 48;2;255;255;255 — a naive string/case compare misses this. Issue #36.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#000000", bg: "#fff" },
        { text: "b", fg: "#000000", bg: "#ffffff" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  it("draws the thin separator for #ABC vs #aabbcc (3-digit hex expansion)", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#000000", bg: "#ABC" },
        { text: "b", fg: "#000000", bg: "#aabbcc" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  it("draws the wide separator for two named colors that resolve apart", () => {
    // "red" and "blue" resolve to #ff0000 and #0000ff — ΔE 52.88, far above
    // MIN_SEPARATOR_DELTA — so the separator decision follows the colors
    // actually painted. This test previously asserted the thin glyph, because
    // both names failed chalk's hex parse and painted black. That was the
    // defect this change fixes.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "red" },
        { text: "b", fg: "#ffffff", bg: "blue" },
      ],
      OPTIONS,
    );
    expect(pieces[1]).toEqual({ text: "▶", fg: "#ff0000", bg: "#0000ff" });
  });

  it("resolves named colors to the same pieces as their mapped hex", () => {
    // The property the separator logic rests on: comparison and painting must
    // agree about what a config value means.
    const named = layoutPowerline([{ text: "a", fg: "white", bg: "red" }], OPTIONS);
    const hex = layoutPowerline([{ text: "a", fg: "#ffffff", bg: "#ff0000" }], OPTIONS);
    expect(named).toEqual(hex);
  });

  it("still draws the wide separator for a genuinely different pair", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "#26a269" },
        { text: "b", fg: "#ffffff", bg: "#0d7377" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("▶");
  });

  it("falls back to the wide separator when separatorThin is empty", () => {
    const pieces = layoutPowerline(
      [
        { text: "$14.21", fg: "#ffffff", bg: "#a67c00" },
        { text: "70%", fg: "#ffffff", bg: "#a67c00" },
      ],
      { ...OPTIONS, separatorThin: "" },
    );
    // Still painted in the previous segment's fg (not bg) so it stays visible
    // even though it's rendering the wide glyph.
    expect(pieces[1]).toEqual({ text: "▶", fg: "#ffffff", bg: "#a67c00" });
  });

  it("falls back to the wide separator when separatorThin is whitespace-only", () => {
    // " " is truthy but has no ink — same merge bug as "", just missed by a
    // naive `|| options.separator` fallback. Issue #36.
    const pieces = layoutPowerline(
      [
        { text: "$14.21", fg: "#ffffff", bg: "#a67c00" },
        { text: "70%", fg: "#ffffff", bg: "#a67c00" },
      ],
      { ...OPTIONS, separatorThin: " " },
    );
    expect(pieces[1]).toEqual({ text: "▶", fg: "#ffffff", bg: "#a67c00" });
  });

  it("draws the thin separator for #abcd vs #aabbcc (unanchored 3-run match)", () => {
    // chalk's regex is unanchored: it finds "abc" inside "#abcd" the same way
    // it finds "aabbcc" directly, so both paint 170;187;204. Issue #36.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#000000", bg: "#abcd" },
        { text: "b", fg: "#000000", bg: "#aabbcc" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  it("draws the thin separator for #12345 vs #112233 (unanchored 3-run match)", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#000000", bg: "#12345" },
        { text: "b", fg: "#000000", bg: "#112233" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  it("draws the thin separator for #gggggg vs '' (both paint black — no hex run in either)", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#000000", bg: "#gggggg" },
        { text: "b", fg: "#000000", bg: "" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  // The wide glyph is painted in the previous segment's bg over this one's, so
  // near-identical backgrounds make it unreadable even though they differ.
  // Below MIN_SEPARATOR_DELTA the thin glyph is used instead. Measured ΔE2000
  // for each pair is in the comment; the two above-threshold cases are the
  // regression guard on the constant. See issue #40.
  it("draws the thin separator when backgrounds are perceptually close", () => {
    // ΔE 4.61 — context-percent warn beside compact-countdown warn.
    const warn = layoutPowerline(
      [
        { text: "70%", fg: "#ffffff", bg: "#a67c00" },
        { text: "~28k left", fg: "#ffffff", bg: "#b8860b" },
      ],
      OPTIONS,
    );
    expect(warn[1]).toEqual({ text: "│", fg: "#ffffff", bg: "#b8860b" });

    // ΔE 6.54 — context-percent danger beside compact-countdown danger.
    const danger = layoutPowerline(
      [
        { text: "95%", fg: "#ffffff", bg: "#c01c28" },
        { text: "Compact imminent!", fg: "#ffffff", bg: "#a01822" },
      ],
      OPTIONS,
    );
    expect(danger[1]).toEqual({ text: "│", fg: "#ffffff", bg: "#a01822" });
  });

  it("keeps the wide separator for backgrounds just above the threshold", () => {
    // ΔE 9.14 — today-spend beside vim-mode NORMAL, in the shipped defaults.
    const vim = layoutPowerline(
      [
        { text: "Today: $3.00", fg: "#ffffff", bg: "#26a269" },
        { text: "NORMAL", fg: "#ffffff", bg: "#2ec27e" },
      ],
      OPTIONS,
    );
    expect(vim[1]).toEqual({ text: "▶", fg: "#26a269", bg: "#2ec27e" });

    // ΔE 9.63 — git-branch beside git-changes, in the shipped defaults.
    const git = layoutPowerline(
      [
        { text: "main", fg: "#ffffff", bg: "#613583" },
        { text: "+2 ~1", fg: "#ffffff", bg: "#7d4fa8" },
      ],
      OPTIONS,
    );
    expect(git[1]).toEqual({ text: "▶", fg: "#613583", bg: "#7d4fa8" });
  });

  // Regression for the crash where an Object.prototype key (e.g.
  // "constructor") reached colorDistance -> normalizeColor -> resolveColor
  // and threw on `.toLowerCase()` on a non-string, blanking the whole
  // statusline. Needs two segments — colorDistance is only invoked for the
  // separator between adjacent pieces, never for a lone segment.
  it("does not throw when a widget bg is an Object.prototype key, and resolves it to a string", () => {
    let pieces: ReturnType<typeof layoutPowerline> = [];
    expect(() => {
      pieces = layoutPowerline(
        [
          { text: "a", fg: "#ffffff", bg: "constructor" },
          { text: "b", fg: "#ffffff", bg: "#0d7377" },
        ],
        OPTIONS,
      );
    }).not.toThrow();
    expect(typeof pieces[0]!.bg).toBe("string");
  });

  it("derives a contrasting foreground when a widget sets bg but not fg", () => {
    const light = layoutPowerline(
      [
        { text: "a", bg: "white" },
        { text: "b", fg: "#ffffff", bg: "#0d7377" },
      ],
      OPTIONS,
    );
    expect(light[0]).toEqual({ text: " a ", fg: "#000000", bg: "#ffffff" });

    const dark = layoutPowerline(
      [
        { text: "a", bg: "#000000" },
        { text: "b", fg: "#ffffff", bg: "#0d7377" },
      ],
      OPTIONS,
    );
    expect(dark[0]).toEqual({ text: " a ", fg: "#ffffff", bg: "#000000" });
  });

  it("respects an explicit fg even when bg is also set", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#123456", bg: "white" },
        { text: "b", fg: "#ffffff", bg: "#0d7377" },
      ],
      OPTIONS,
    );
    expect(pieces[0]).toEqual({ text: " a ", fg: "#123456", bg: "#ffffff" });
  });

  it("uses the theme's own fg/bg pair unchanged when a widget sets neither", () => {
    const pieces = layoutPowerline(
      [{ text: "a" }, { text: "b" }],
      OPTIONS,
    );
    // Same expectation as "falls back to the theme palette when a widget sets
    // no colors" above — this test exists specifically to pin that the
    // bg-without-fg contrast derivation does NOT fire here.
    expect(pieces[0]).toEqual({ text: " a ", fg: "#ffffff", bg: "#5f5faf" });
  });
});

describe("default bar adjacency across the alert bands", () => {
  // context-percent and compact-countdown sit next to each other on line 1 and
  // now enter their bands on the same turn by construction. Their alert shades
  // are ΔE 4.61 (amber) and 6.54 (red) apart — both under MIN_SEPARATOR_DELTA —
  // so the wide glyph would be invisible and the thin one must be drawn.
  // Assert on rendered output: a config-level check cannot see this, because
  // both widgets override bg at render time. See issues #36, #40.
  function renderDefaultBar(usedPercentage: number, windowSize: number): string {
    const context = makeContext({
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        context_window: {
          used_percentage: usedPercentage,
          context_window_size: windowSize,
        },
      },
      terminalWidth: 400,
    });
    const settings = makeSettings({
      lines: DEFAULT_SETTINGS.lines,
      powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
    });
    return stripAnsi(renderStatusline(context, settings)).split("\n")[0]!;
  }

  // context-percent's text ends with the window-size suffix ")", and
  // compact-countdown's begins with "~" or "Compact". Matching that specific
  // junction keeps the assertion about these two segments — a whole-line
  // search for the glyph would also see every other pair on the bar.
  function separatorBetweenAlertSegments(line: string): string | undefined {
    return /\)\s*(│|▶)\s*(?:~|Compact)/.exec(line)?.[1];
  }

  it.each([
    ["amber band, 200k", 73.5, 200_000],
    ["red band, 200k", 81, 200_000],
    ["compact imminent, 200k", 83.5, 200_000],
    ["amber band, 1M", 94.7, 1_000_000],
    ["red band, 1M", 96.2, 1_000_000],
  ])("draws a thin separator between the two alert segments (%s)", (_label, pct, size) => {
    const line = renderDefaultBar(pct, size);
    expect(separatorBetweenAlertSegments(line)).toBe("│");
  });

  it("uses the wide separator when neither segment is alerting", () => {
    const line = renderDefaultBar(25, 200_000);
    expect(separatorBetweenAlertSegments(line)).toBe("▶");
  });
});

describe("compact fitting measures the real line", () => {
  const widgets = [
    { type: "custom-text", text: "alpha", priority: 1 },
    { type: "custom-text", text: "bravo", priority: 2 },
    { type: "custom-text", text: "charlie", priority: 3 },
    { type: "custom-text", text: "delta", priority: 4 },
  ];

  // The natural (untruncated) width of a single widget's segment, rendered
  // alone under the same settings. Used as a packing tolerance below: if the
  // greedy loop stopped early, the unused budget would exceed the cost of
  // whatever candidate it declined to add next.
  function naturalSegmentWidth(text: string, powerlineOn: boolean): number {
    const settings = makeSettings({
      lines: [{ widgets: [{ type: "custom-text", text, priority: 1 }], flex: "left" }],
      powerline: {
        enabled: powerlineOn,
        theme: "default",
        separator: "▶",
        separatorThin: "│",
      },
      compact: { mode: "always", threshold: 80 },
    });
    const line = renderStatusline(makeContext({ terminalWidth: 1000 }), settings);
    return visibleLength(line);
  }

  // Ground truth for which prefix of `widgets` should survive at a given
  // budget — computed WITHOUT going through `measureLine`/`applyFlex` at
  // all, so this cannot be fooled the same way the width-only assertions
  // below can be. `layoutPowerline` paints powerline segments directly
  // (no width parameter, no dependency on flex.ts); plain mode's segments
  // are joined with no separator, so the natural content is exactly the
  // widgets' own text concatenated. `cumulative[i]` is the natural width of
  // the first `i + 1` widgets, in list order (their priority order here).
  //
  // Final review reproduced a defect this ground truth exists to catch:
  // mutating `applyFlex` (src/render/flex.ts:13) to pad at unknown width
  // makes the real `measureLine` massively overstate every candidate's
  // cost, so the greedy compact loop keeps only `alpha` at every budget in
  // the sweep. Every width-only assertion below stayed green regardless,
  // because plain mode's final render pads the survivors out to exactly
  // `width` — satisfying "fits the budget" and "packs the budget" whether
  // one widget survived or four. Comparing WHICH TEXT is actually present
  // against this independently-computed cumulative table is what turns
  // that silent misfit into a failing assertion.
  function naturalCumulativeWidths(powerlineOn: boolean): number[] {
    const options = { theme: "default", separator: "▶", separatorThin: "│" };
    return widgets.map((_, i) => {
      const prefix = widgets
        .slice(0, i + 1)
        .map((w) => ({ text: w.text, fg: undefined, bg: undefined }));
      if (powerlineOn) {
        return visibleLength(
          layoutPowerline(prefix, options)
            .map((p) => p.text)
            .join(""),
        );
      }
      return prefix.map((o) => o.text).join("").length;
    });
  }

  // Mirrors the real greedy loop in `renderCompact`: the first widget is
  // always kept regardless of budget, and each subsequent one is kept only
  // while the cumulative natural width it would add still fits — the first
  // one that doesn't fit stops the whole loop (`break`, not `continue`).
  function expectedSurvivorCount(cumulative: number[], budget: number): number {
    let count = 1;
    for (let i = 1; i < cumulative.length; i++) {
      if (cumulative[i]! <= budget) count = i + 1;
      else break;
    }
    return count;
  }

  it.each([true, false])("fills the budget without overflowing it (powerline=%s)", (powerlineOn) => {
    const settings = makeSettings({
      lines: [{ widgets, flex: "left" }],
      powerline: {
        enabled: powerlineOn,
        theme: "default",
        separator: "▶",
        separatorThin: "│",
      },
      compact: { mode: "always", threshold: 80 },
    });

    const longestSegmentCost = Math.max(
      ...widgets.map((w) => naturalSegmentWidth(w.text, powerlineOn)),
    );
    // The width the whole set occupies once nothing is left to drop — the
    // ceiling the packing bound below must respect once every widget fits.
    const fullWidth = visibleLength(
      renderStatusline(makeContext({ terminalWidth: 1000 }), settings),
    );
    const cumulative = naturalCumulativeWidths(powerlineOn);

    // Sweep every budget from "one segment barely fits" to "everything fits".
    for (let width = 10; width <= 60; width++) {
      const line = renderStatusline(makeContext({ terminalWidth: width }), settings);
      const plain = stripAnsi(line);

      // A correctly fitted line never needs end-truncation. If fitting
      // stopped happening (e.g. the loop always added everything), the
      // over-long line would fall through to truncateAnsi and pick up "…".
      expect(plain).not.toContain("…");

      // No overflow: the measured line must fit inside the budget.
      expect(visibleLength(line)).toBeLessThanOrEqual(width);

      // Packs the budget rather than stopping early: any unused space must
      // be no larger than the largest segment that could have been the next
      // candidate, or the loop should have kept going. Once every widget
      // already fits there is no next candidate to compare against, so the
      // bound is capped at the set's full natural width.
      expect(visibleLength(line)).toBeGreaterThanOrEqual(
        Math.min(width, fullWidth) - longestSegmentCost,
      );

      // CONTENT, not just width: assert which segments actually survived,
      // against the independently-computed ground truth above. A width-only
      // assertion is satisfiable by padding alone (plain mode's final render
      // pads survivors out to exactly `width` regardless of how many there
      // are) — this is the check that isn't.
      const expectedCount = expectedSurvivorCount(cumulative, width);
      for (let i = 0; i < expectedCount; i++) {
        expect(plain).toContain(widgets[i]!.text);
      }
      if (expectedCount < widgets.length) {
        expect(plain).not.toContain(widgets[expectedCount]!.text);
      }
    }
  });

  it("keeps a segment the old arithmetic would have dropped", () => {
    const settings = makeSettings({
      lines: [{ widgets, flex: "left" }],
      powerline: {
        enabled: true,
        theme: "default",
        separator: "▶",
        separatorThin: "│",
      },
      compact: { mode: "always", threshold: 80 },
    });

    // Four segments of 5/5/7/5 characters cost 5+3 + 5+3 + 7+3 + 5+3 = 34
    // columns in powerline mode. The old estimate charged 2 more per segment,
    // i.e. 42, and so dropped the last segment at any budget below 42.
    const line = renderStatusline(makeContext({ terminalWidth: 40 }), settings);
    expect(stripAnsi(line)).toContain("delta");
  });
});

// `measureLine` (src/render/renderer.ts) is only correct because it measures
// a line by rendering it with `terminalWidth: undefined` and trusting that
// unknown width means "no padding, no truncation" — it doesn't compute a
// width itself, it reads one off a real render. The compact-fitting tests
// above exercise that trust indirectly, through whatever the fitting
// algorithm happens to produce. This describe block tests the invariant
// directly: render at `terminalWidth: undefined` and require the output to
// equal its own natural content exactly, with nothing added or removed.
//
// Only the truncation half of this was ever guarded before final review
// (incidentally, by a Task 5 real-payload test asserting no "…" at a
// specific width). The padding half had no test at all: final review
// mutated `applyFlex` (src/render/flex.ts:13) to pad instead of no-op at
// unknown width, and all 437 existing tests kept passing.
describe("renderLine at unknown terminal width neither pads nor truncates", () => {
  const widgets = [
    { type: "custom-text", text: "alpha", priority: 1 },
    { type: "custom-text", text: "bravo", priority: 2 },
  ];

  // Every configured flex mode is exercised, not just the default "left" —
  // `applyFlex`'s unknown-width guard sits BEFORE the mode switch, so it is
  // shared by all of them, and a mutation that removed or narrowed that
  // guard could plausibly still special-case "left".
  const flexModes = ["left", "right", "center", "space-between"] as const;

  it.each(flexModes)("plain mode: equals natural content exactly (flex=%s)", (flex) => {
    const settings = makeSettings({
      lines: [{ widgets, flex }],
      powerline: { enabled: false, theme: "default", separator: "▶", separatorThin: "│" },
    });
    const output = renderStatusline(makeContext({ terminalWidth: undefined }), settings);
    const plain = stripAnsi(output);

    // Ground truth independent of applyFlex: plain mode joins segments with
    // no separator, so the natural content is exactly the widgets' own text,
    // concatenated in order.
    const expected = widgets.map((w) => w.text).join("");
    expect(plain).toBe(expected);
    expect(plain).not.toContain("…");
    expect(plain.startsWith(" ")).toBe(false);
    expect(plain.endsWith(" ")).toBe(false);
  });

  it("powerline mode: equals natural content exactly", () => {
    const options = { theme: "default", separator: "▶", separatorThin: "│" };
    const settings = makeSettings({
      lines: [{ widgets, flex: "left" }],
      powerline: { enabled: true, ...options },
    });
    const output = renderStatusline(makeContext({ terminalWidth: undefined }), settings);
    const plain = stripAnsi(output);

    // Ground truth from `layoutPowerline` directly — the exact pieces
    // `renderLine`'s powerline branch paints, with no width parameter at
    // all, so this is unaffected by anything `applyFlex`/`truncateAnsi` do.
    const outputs = widgets.map((w) => ({ text: w.text, fg: undefined, bg: undefined }));
    const expected = layoutPowerline(outputs, options)
      .map((p) => p.text)
      .join("");
    expect(plain).toBe(expected);
    expect(plain).not.toContain("…");
    expect(plain.endsWith(" ")).toBe(false);
  });

  it("does not shrink either — measureLine depends on this", () => {
    const context = makeContext({
      terminalWidth: undefined,
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        workspace: { project_dir: "/tmp/an-extremely-long-project-directory-name" },
      },
    });
    const settings = makeSettings({
      lines: [{ widgets: [{ type: "project" }], flex: "left" }],
      powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
      compact: { mode: "never", threshold: 80 },
    });

    const line = stripAnsi(renderStatusline(context, settings));
    expect(line).toContain("an-extremely-long-project-directory-name");
    expect(line).not.toContain("…");
  });
});

describe("long segments shrink to fit instead of truncating the line", () => {
  // custom-text is not shrinkable, so drive the shrink path through the real
  // widgets instead: a context whose project_dir and cwd produce long names.
  function longNameContext(width: number | undefined): RenderContext {
    return makeContext({
      terminalWidth: width,
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        workspace: { project_dir: "/tmp/an-extremely-long-project-directory-name" },
      },
    });
  }

  const projectSettings = makeSettings({
    lines: [
      {
        widgets: [
          { type: "project" },
          { type: "custom-text", text: "Today: $2.10" },
        ],
        flex: "left",
      },
    ],
    powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
    compact: { mode: "never", threshold: 80 },
  });

  it("shrinks the project segment rather than cutting the line", () => {
    const natural = visibleLength(
      renderStatusline(longNameContext(undefined), projectSettings),
    );
    const budget = natural - 6;

    const line = stripAnsi(renderStatusline(longNameContext(budget), projectSettings));

    // The line fits...
    expect(visibleLength(line)).toBeLessThanOrEqual(budget);
    // ...the unshrinkable segment survived intact...
    expect(line).toContain("Today: $2.10");
    // ...and the shrunk segment carries the ellipsis, not the line's tail.
    expect(line).toContain("…");
    expect(line.trimEnd().endsWith("…")).toBe(false);
  });

  it("leaves everything alone when the line already fits", () => {
    const natural = visibleLength(
      renderStatusline(longNameContext(undefined), projectSettings),
    );
    const roomy = stripAnsi(renderStatusline(longNameContext(natural + 20), projectSettings));

    expect(roomy).toContain("an-extremely-long-project-directory-name");
    expect(roomy).not.toContain("…");
  });

  it("falls back to truncation when shrinking to the floor is not enough", () => {
    const line = stripAnsi(renderStatusline(longNameContext(14), projectSettings));
    expect(visibleLength(line)).toBeLessThanOrEqual(14);

    // A budget this tight is not just "narrower than natural" — it's narrower
    // than the shrinkable segment's floor plus the unshrinkable segment
    // combined, so shrinking alone cannot make it fit and truncateAnsi has to
    // cut on top of the shrink. Assert the SIGNATURE of both mechanisms
    // firing together, not just the width bound truncateAnsi guarantees on
    // its own (which a reverted feature satisfies trivially): two ellipses —
    // one from the shrunk project segment, one from truncateAnsi biting into
    // the second segment — and the powerline separator, which only survives
    // into the output if shrinking ran first and got far enough for layout to
    // reach the second segment at all. With shrinking disabled, the raw
    // (~46-character) project text alone consumes the entire 14-column
    // budget, so truncateAnsi cuts before the separator or second segment are
    // ever reached: one ellipsis, no separator.
    expect(line.split("…").length - 1).toBe(2);
    expect(line).toContain("▶");
  });

  // git-branch is the other widget marked shrinkable, and unlike project it
  // shells out to real `git` against `stdin.cwd` (src/utils/git.ts) rather
  // than reading anything off the payload — a fixture whose `cwd` doesn't
  // exist on disk makes it silently emit nothing, which would make this test
  // pass vacuously no matter what `shrinkable` is set to. Build a real,
  // throwaway git repo with a fixed, deterministic branch name so the widget
  // genuinely executes, reusing the exact repo-construction helper
  // `default-layout-width.test.ts` built for this same problem rather than
  // inventing a second one.
  const gitBranchSettings = makeSettings({
    lines: [
      {
        widgets: [
          { type: "git-branch" },
          { type: "custom-text", text: "Today: $2.10" },
        ],
        flex: "left",
      },
    ],
    powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
    compact: { mode: "never", threshold: 80 },
  });

  function gitBranchContext(width: number | undefined, cwd: string): RenderContext {
    return makeContext({
      terminalWidth: width,
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        cwd,
      },
    });
  }

  it("shrinks the git-branch segment rather than cutting the line", () => {
    const repoDir = makeDeterministicGitRepo();
    try {
      const natural = visibleLength(
        renderStatusline(gitBranchContext(undefined, repoDir), gitBranchSettings),
      );
      const budget = natural - 6;

      const line = stripAnsi(
        renderStatusline(gitBranchContext(budget, repoDir), gitBranchSettings),
      );

      // The line fits...
      expect(visibleLength(line)).toBeLessThanOrEqual(budget);
      // ...the unshrinkable segment survived intact...
      expect(line).toContain("Today: $2.10");
      // ...and the shrunk segment carries the ellipsis, not the line's tail.
      expect(line).toContain("…");
      expect(line.trimEnd().endsWith("…")).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// The design doc's "compact mode" section says renderCompact's own logic
// (drop-by-priority, fit measured against UNSHRUNK widths) is unchanged --
// true. It does NOT mean shrinking is absent from compact's rendered output:
// renderCompact's last line is `renderLine(fitted, settings, context, "left")`
// with the real terminal width, and that is the exact same renderLine the
// full layout uses, shrink block included. The greedy loop always keeps the
// first widget regardless of its own width ("fitted.length > 0" gates the
// budget check), so a long shrinkable segment can survive compaction wider
// than the terminal and still needs shrinking on the final render. Reproduced
// by the reviewer at width 20 with a long `project` segment.
describe("compact mode also shrinks (renderCompact renders through the shared renderLine)", () => {
  it("shrinks the surviving project segment instead of tail-cutting the compact line", () => {
    const context = makeContext({
      terminalWidth: 20,
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        workspace: { project_dir: "/tmp/an-extremely-long-project-directory-name" },
      },
    });
    const settings = makeSettings({
      lines: [{ widgets: [{ type: "project", priority: 1 }], flex: "left" }],
      compact: { mode: "always", threshold: 80 },
      powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
    });

    const output = renderStatusline(context, settings);
    expect(output.split("\n")).toHaveLength(1);
    const plain = stripAnsi(output);

    // Exact reproduction: the project text shrinks to "an-extremely-lon…"
    // (16 chars + ellipsis) padded and followed by the powerline arrow.
    expect(plain).toBe(" an-extremely-lon… ▶");

    // CONTENT, not width: a bare tail-cut (truncateAnsi with no shrink) would
    // end the whole line on "…" with nothing after it. Here the ellipsis
    // sits inside the segment -- padding and the arrow follow it -- which is
    // only possible if the segment itself was shortened before layout, not
    // the finished line cut from the end.
    expect(plain.trimEnd().endsWith("…")).toBe(false);
    expect(plain).toContain("…");

    // The full, unshrunk directory name must be gone -- proves real
    // shrinking happened rather than everything coincidentally fitting.
    expect(plain).not.toContain("an-extremely-long-project-directory-name");
  });
});
