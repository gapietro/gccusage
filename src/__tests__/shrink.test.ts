import { describe, it, expect } from "vitest";
import { shrinkOutputs, MIN_SHRUNK_TEXT } from "../render/shrink.js";
import { visibleLength } from "../utils/terminal.js";
import type { WidgetOutput } from "../widgets/base.js";

function shrinkable(text: string): WidgetOutput {
  return { text, shrinkable: true };
}

describe("shrinkOutputs", () => {
  it("returns the outputs untouched when there is no overflow", () => {
    const outputs = [shrinkable("feature/some-branch"), { text: "Today: $2.10" }];
    expect(shrinkOutputs(outputs, 0)).toEqual(outputs);
    expect(shrinkOutputs(outputs, -5)).toEqual(outputs);
  });

  it("never trims a segment that is not marked shrinkable", () => {
    const outputs = [{ text: "Today: $2.10" }, { text: "In: 122" }];
    expect(shrinkOutputs(outputs, 10)).toEqual(outputs);
  });

  it("removes exactly the requested overflow", () => {
    const outputs = [shrinkable("feature/a-fairly-long-branch-name")];
    const before = visibleLength(outputs[0]!.text);
    const after = shrinkOutputs(outputs, 7);
    expect(before - visibleLength(after[0]!.text)).toBe(7);
  });

  it("ends a trimmed segment in an ellipsis, counted in its width", () => {
    const after = shrinkOutputs([shrinkable("abcdefghijklmnop")], 4);
    expect(after[0]!.text).toBe("abcdefghijk…");
    expect(visibleLength(after[0]!.text)).toBe(12);
  });

  it("trims the widest segment first rather than the first one", () => {
    const outputs = [shrinkable("short-name"), shrinkable("a-much-longer-branch-name")];
    const after = shrinkOutputs(outputs, 3);
    expect(after[0]!.text).toBe("short-name");
    expect(visibleLength(after[1]!.text)).toBe(visibleLength(outputs[1]!.text) - 3);
  });

  it("levels the two widest segments before trimming either below the other", () => {
    // 20 and 10 wide; removing 8 should come off the wider one, taking it down
    // toward its neighbour rather than annihilating it.
    const outputs = [shrinkable("x".repeat(20)), shrinkable("y".repeat(10))];
    const after = shrinkOutputs(outputs, 8);
    const widths = after.map((o) => visibleLength(o.text));
    expect(widths[0]! + widths[1]!).toBe(22);
    expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(2);
  });

  it("never trims a segment below the floor", () => {
    const outputs = [shrinkable("abcdefghijklmnop")];
    const after = shrinkOutputs(outputs, 1000);
    expect(visibleLength(after[0]!.text)).toBe(MIN_SHRUNK_TEXT);
  });

  it("stops when every shrinkable segment is at the floor instead of looping", () => {
    const outputs = [shrinkable("abcdefghijklmnop"), shrinkable("qrstuvwxyz")];
    const after = shrinkOutputs(outputs, 10_000);
    expect(after.map((o) => visibleLength(o.text))).toEqual([
      MIN_SHRUNK_TEXT,
      MIN_SHRUNK_TEXT,
    ]);
  });

  it("slices by code points so an astral character is never split", () => {
    // Each rocket is one code point but TWO UTF-16 code units, and
    // visibleLength counts code units — so 20 rockets measure as 40 columns.
    // The overflow must exceed 20 to force an actual trim; a smaller one
    // leaves the text untouched and the test proves nothing.
    const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(20))], 25);

    // Trimming really happened.
    expect(after[0]!.text).not.toBe("\u{1F680}".repeat(20));
    // No lone surrogate anywhere, and every retained char is a whole rocket.
    expect(after[0]!.text).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(
      Array.from(after[0]!.text).every((c) => c === "\u{1F680}" || c === "…"),
    ).toBe(true);
  });

  it("does not mutate the outputs it was given", () => {
    const outputs = [shrinkable("a-much-longer-branch-name")];
    const original = outputs[0]!.text;
    shrinkOutputs(outputs, 6);
    expect(outputs[0]!.text).toBe(original);
  });
});
