import { describe, it, expect } from "vitest";
import { renderStatusline } from "../render/renderer.js";
import type { RenderContext } from "../types/render-context.js";
import type { Settings } from "../config/schema.js";
import { stripAnsi } from "../utils/terminal.js";

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

describe("renderStatusline", () => {
  it("renders a simple single-line config", () => {
    const settings: Settings = {
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
      costSource: "auto",
    };

    const output = renderStatusline(makeContext(), settings);
    const plain = stripAnsi(output);
    expect(plain).toContain("Sonnet 4");
    expect(plain).toContain("$2.45");
    expect(plain).toContain("|");
  });

  it("skips lines with no output", () => {
    const settings: Settings = {
      lines: [
        {
          widgets: [{ type: "block-timer" }],
          flex: "left",
        },
      ],
      costSource: "auto",
    };

    const output = renderStatusline(makeContext(), settings);
    expect(output).toBe("");
  });

  it("cleans leading/trailing separators", () => {
    const settings: Settings = {
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
      costSource: "auto",
    };

    const output = renderStatusline(makeContext(), settings);
    const plain = stripAnsi(output);
    // Should not start or end with separator
    expect(plain.trimEnd().startsWith("|")).toBe(false);
  });

  it("compact mode collapses to single line with priority ordering", () => {
    const settings: Settings = {
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
      costSource: "auto",
    };

    const output = renderStatusline(makeContext(), settings);
    // Should be a single line (no newlines)
    expect(output.split("\n")).toHaveLength(1);
    const plain = stripAnsi(output);
    expect(plain).toContain("Sonnet 4");
    expect(plain).toContain("$2.45");
  });

  it("compact auto mode triggers on narrow terminal", () => {
    const settings: Settings = {
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
      costSource: "auto",
    };

    // Wide terminal — should be multi-line
    const wide = renderStatusline(makeContext({ terminalWidth: 120 }), settings);
    expect(wide.split("\n").length).toBeGreaterThanOrEqual(2);

    // Narrow terminal — should be single-line
    const narrow = renderStatusline(makeContext({ terminalWidth: 60 }), settings);
    expect(narrow.split("\n")).toHaveLength(1);
  });
});
