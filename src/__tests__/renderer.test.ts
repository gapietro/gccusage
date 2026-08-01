import { describe, it, expect } from "vitest";
import { renderStatusline } from "../render/renderer.js";
import { layoutPowerline } from "../render/powerline.js";
import type { RenderContext } from "../types/render-context.js";
import type { Settings } from "../config/schema.js";
import { stripAnsi, visibleLength } from "../utils/terminal.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";

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
