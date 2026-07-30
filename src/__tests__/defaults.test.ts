import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { getWidget } from "../widgets/registry.js";

describe("DEFAULT_SETTINGS", () => {
  it("references only registered widget types", () => {
    for (const line of DEFAULT_SETTINGS.lines) {
      for (const widget of line.widgets) {
        expect(getWidget(widget.type), `unregistered widget: ${widget.type}`).not.toBeNull();
      }
    }
  });

  it("never places two segments with the same background side by side", () => {
    // The powerline separator is drawn in the previous segment's bg over the
    // next segment's bg, so identical neighbours render an invisible arrow.
    for (const line of DEFAULT_SETTINGS.lines) {
      for (let i = 1; i < line.widgets.length; i++) {
        const prev = line.widgets[i - 1]!;
        const curr = line.widgets[i]!;
        if (prev.bg === undefined || curr.bg === undefined) continue;
        expect(prev.bg, `${prev.type} and ${curr.type} share a background`).not.toBe(curr.bg);
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
