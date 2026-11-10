import { describe, it, expect } from "vitest";
import type { RenderContext } from "../types/render-context.js";
import { vimModeWidget } from "../widgets/vim-mode.js";
import { VIM_INSERT, VIM_NORMAL } from "../widgets/alert-colors.js";

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
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

const withMode = (mode: string) =>
  makeContext({ stdin: { model: "claude-opus-5-5", vim: { mode } } as RenderContext["stdin"] });

describe("vim-mode widget", () => {
  it.each([
    ["NORMAL", VIM_NORMAL],
    ["INSERT", VIM_INSERT],
  ])("renders %s on its own colour", (mode, bg) => {
    expect(vimModeWidget.render(withMode(mode), { type: "vim-mode" })).toEqual({
      text: mode,
      fg: "#ffffff",
      bg,
    });
  });

  it("renders an unknown mode on the NORMAL fallback rather than vanishing", () => {
    expect(vimModeWidget.render(withMode("VISUAL"), { type: "vim-mode" })?.bg).toBe(VIM_NORMAL);
  });

  // #141: the mode comes from the stdin payload. A plain-object lookup resolves
  // these to inherited functions/objects, which then throw in resolveColor and
  // blank the whole bar.
  it.each([["constructor"], ["toString"], ["__proto__"], ["hasOwnProperty"], ["valueOf"]])(
    "gives %s the fallback colour, not an inherited property (#141)",
    (mode) => {
      const output = vimModeWidget.render(withMode(mode), { type: "vim-mode" });
      expect(output?.bg).toBe(VIM_NORMAL);
      expect(output?.text).toBe(mode);
    },
  );
});
