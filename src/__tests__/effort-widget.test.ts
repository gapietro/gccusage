import { describe, it, expect } from "vitest";
import * as v from "valibot";
import type { RenderContext } from "../types/render-context.js";
import { StatusJsonSchema } from "../types/status-json.js";
import { effortWidget } from "../widgets/effort.js";
import { getWidget } from "../widgets/registry.js";
import {
  EFFORT_COLORS,
  EFFORT_FALLBACK,
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from "../widgets/alert-colors.js";

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

const withEffort = (level: unknown) =>
  makeContext({ stdin: { model: "claude-opus-5-5", effort: { level } } as RenderContext["stdin"] });

describe("effort widget (#139)", () => {
  it("is registered as 'effort'", () => {
    expect(getWidget("effort")).toBe(effortWidget);
  });

  it.each([...EFFORT_COLORS.entries()])("renders %s as bare text on its own colour", (level, bg) => {
    expect(effortWidget.render(withEffort(level), { type: "effort" })).toEqual({
      text: level,
      fg: "#ffffff",
      bg,
    });
  });

  it("renders nothing when the payload has no effort (model without effort support)", () => {
    expect(effortWidget.render(makeContext({ stdin: { model: "claude-sonnet-4-5" } }), { type: "effort" })).toBeNull();
  });

  it.each([[""], ["   "], [undefined]])("renders nothing for an empty level %j", (level) => {
    expect(effortWidget.render(withEffort(level), { type: "effort" })).toBeNull();
  });

  it("renders an unknown level on the neutral fallback rather than vanishing", () => {
    expect(effortWidget.render(withEffort("ultra"), { type: "effort" })).toEqual({
      text: "ultra",
      fg: "#ffffff",
      bg: EFFORT_FALLBACK,
    });
  });

  it.each([["constructor"], ["toString"], ["__proto__"]])(
    "gives %s the fallback colour, not an inherited property",
    (level) => {
      expect(effortWidget.render(withEffort(level), { type: "effort" })?.bg).toBe(EFFORT_FALLBACK);
    },
  );

  it("lets the user's fg/bg override the level colour", () => {
    expect(effortWidget.render(withEffort("max"), { type: "effort", fg: "#000000", bg: "#ffffff" })).toEqual({
      text: "max",
      fg: "#000000",
      bg: "#ffffff",
    });
  });

  it("honours label and icon like the model widget", () => {
    expect(effortWidget.render(withEffort("high"), { type: "effort", label: "Effort", icon: "⚡" })?.text).toBe(
      "⚡ Effort high",
    );
    expect(effortWidget.render(withEffort("high"), { type: "effort", label: "Effort" })?.text).toBe("Effort high");
  });

  it.each([["MAX", EFFORT_MAX], ["High", EFFORT_HIGH], [" XHigh ", EFFORT_XHIGH]])(
    "colours %j by its level regardless of case, showing the text as sent",
    (level, bg) => {
      const out = effortWidget.render(withEffort(level), { type: "effort" });
      expect(out?.bg).toBe(bg);
      expect(out?.text).toBe(level.trim());
    },
  );

  // The per-level test above reads its expected colour from the same Map the
  // widget uses, so it cannot catch two levels swapped inside the Map. Pin
  // the whole mapping to the named constants.
  it("maps each level to its own named colour", () => {
    expect(Object.fromEntries(EFFORT_COLORS)).toEqual({
      low: EFFORT_LOW,
      medium: EFFORT_MEDIUM,
      high: EFFORT_HIGH,
      xhigh: EFFORT_XHIGH,
      max: EFFORT_MAX,
    });
  });

  // Proven against what the parser actually produces, not only hand-built
  // stdin: each of these malformed blocks parses to an effort with no usable
  // level, so a widget keyed on `effort` truthiness would draw an empty
  // segment.
  it.each([[{ effort: ["high"] }], [{ effort: {} }], [{ effort: { level: 7 } }]])(
    "renders nothing for the parsed payload %j",
    (payload) => {
      const parsed = v.parse(StatusJsonSchema, payload);
      expect(effortWidget.render(makeContext({ stdin: parsed }), { type: "effort" })).toBeNull();
    },
  );
});
