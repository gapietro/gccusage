import { describe, it, expect } from "vitest";
import { getWidgetTypes } from "../widgets/registry.js";
import { WIDGET_EXPECTATIONS } from "./fixtures/widget-expectations.js";

describe("expectation table completeness", () => {
  it("covers every registered widget type", () => {
    const missing = getWidgetTypes().filter((t) => !(t in WIDGET_EXPECTATIONS));
    expect(missing, `registered widgets with no expectation entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no entry for an unregistered widget type", () => {
    const registered = new Set(getWidgetTypes());
    const stale = Object.keys(WIDGET_EXPECTATIONS).filter((t) => !registered.has(t));
    expect(stale, `expectation entries with no registered widget: ${stale.join(", ")}`).toEqual([]);
  });
});
