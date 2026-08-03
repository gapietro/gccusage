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

  describe("the floor invariant under astral (surrogate-pair) text", () => {
    // A rocket is one code point but TWO UTF-16 code units, and visibleLength
    // counts code units. That mismatch is exactly what let a naive `trimTo`
    // step straight past MIN_SHRUNK_TEXT: removing one rocket removes two
    // columns, so a segment sitting at 9 columns can jump to 7 in a single
    // removal with nothing between. These tests pin the floor for text built
    // entirely (or partly) from such characters, not just single-column ASCII.

    it("never drops emoji-only text below the floor under a huge overflow", () => {
      // 20 rockets measure 40 columns. An overflow of 10,000 forces the
      // segment as low as the algorithm will take it — the floor, or the
      // nearest width above it that surrogate-pair granularity allows.
      const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(20))], 10_000);
      expect(visibleLength(after[0]!.text)).toBeGreaterThanOrEqual(MIN_SHRUNK_TEXT);
    });

    it("never drops mixed ascii+emoji text below the floor under a huge overflow", () => {
      // Single-column and double-column characters interleaved: a removal
      // near the end of the string can still remove either 1 or 2 columns
      // depending on which kind of character it lands on.
      const after = shrinkOutputs(
        [shrinkable("abc\u{1F680}def\u{1F680}ghi\u{1F680}jkl\u{1F680}mno")],
        10_000,
      );
      expect(visibleLength(after[0]!.text)).toBeGreaterThanOrEqual(MIN_SHRUNK_TEXT);
    });

    it("holds the floor invariant across a sweep of overflow values", () => {
      // A single overflow value can pass by luck — whether the parity of
      // "columns to remove" happens to line up with "2 columns per rocket"
      // for that particular number. Sweeping many values is what would have
      // caught the original bug instead of missing it by chance.
      for (let overflow = 1; overflow <= 40; overflow++) {
        const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(20))], overflow);
        expect(visibleLength(after[0]!.text)).toBeGreaterThanOrEqual(MIN_SHRUNK_TEXT);
      }
    });

    it("never emits a lone (unpaired) surrogate code unit across the same sweep", () => {
      // A regex character class for the surrogate range only matches an
      // actual lone surrogate under the `u` flag — a valid pair combines into
      // one astral code point, which falls outside \uD800-\uDFFF entirely.
      for (let overflow = 1; overflow <= 40; overflow++) {
        const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(20))], overflow);
        expect(after[0]!.text).not.toMatch(/[\uD800-\uDFFF]/u);
      }
    });
  });

  describe("true output of the two reported reproductions", () => {
    // Both numbers below were derived by hand-tracing trimTo/shrinkOutputs
    // (not by running the code and copying whatever came out), then
    // confirmed against the real module via a killable subprocess before
    // being written here — see task-1-report.md for the trace and the
    // subprocess transcript. Reported round-1 numbers for both cases were
    // wrong: the first case actually hung forever (an unrelated infinite-loop
    // defect in the outer loop, fixed alongside these tests), and the second
    // settled at 15, not round 1's claimed 9.

    it("repro 1: 20 rockets, overflow 10_000 -> floor-adjacent width 9, and terminates", () => {
      const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(20))], 10_000);
      expect(after[0]!.text).toBe("\u{1F680}\u{1F680}\u{1F680}\u{1F680}…");
      expect(visibleLength(after[0]!.text)).toBe(9);
    });

    it("repro 2: 10 rockets, overflow 4 -> width 15 (removes 5, not 4, by parity)", () => {
      const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(10))], 4);
      expect(after[0]!.text).toBe(
        "\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}…",
      );
      expect(visibleLength(after[0]!.text)).toBe(15);
    });
  });

  describe("a parked (stuck) segment does not stop other segments from shrinking", () => {
    // Mutating `stuck.add(widest); continue;` to `stuck.add(widest); break;`
    // (src/render/shrink.ts) leaves every other test in this suite green: no
    // other case has one shrinkable segment park above the floor WHILE a
    // second shrinkable segment still has room left to give. This is that
    // case.
    //
    // 20 rockets (2 columns/code-unit each) cannot land exactly on
    // MIN_SHRUNK_TEXT (8): repro 1 above already pins that, alone, it parks
    // one column short, at width 9 -- "\u{1F680}\u{1F680}\u{1F680}\u{1F680}…".
    // A plain-ASCII segment moves 1 column per removed character, so it CAN
    // land exactly on 8.
    //
    // Widths below were derived by hand-tracing shrinkOutputs/trimTo (both
    // widest-first selection and trimTo's floor peek-ahead), not by running
    // the code and copying the output:
    //
    // Every round, the widest still-eligible segment is trimmed toward the
    // runner-up (leveling), alternating between the rocket segment and the
    // ascii one as they cross. The rocket segment's count of surviving
    // rockets falls 20 -> 9 -> 8 -> 7 -> 6 -> 5 -> 4, and at 4 rockets
    // (width 9) any further removal would land at 3 rockets = width 7, one
    // below the floor -- trimTo's peek-ahead refuses, so the segment is
    // marked stuck at width 9 with zero progress made that round.
    //
    // At the moment the rocket segment parks, the ascii segment sits at 8
    // letters + ellipsis (width 9) -- ABOVE the floor, with room left. Real
    // code `continue`s: the outer loop runs again, the rocket segment is now
    // excluded (stuck), and the ascii segment -- still the only eligible
    // one -- gets trimmed one more step, to 7 letters + ellipsis, width 8,
    // exactly the floor. Mutated code `break`s the instant the rocket
    // segment parks, so the ascii segment is abandoned at width 9
    // ("abcdefgh…") and never reaches the floor.
    it("finishes shrinking an ascii segment to the floor after an emoji segment parks above it", () => {
      const outputs = [
        shrinkable("\u{1F680}".repeat(20)), // width 40; parks at width 9
        shrinkable("abcdefghijklmnopqrst"), // width 20; can reach the floor (8) exactly
      ];
      const after = shrinkOutputs(outputs, 10_000);

      // The rocket segment parks floor-adjacent, same value as repro 1.
      expect(after[0]!.text).toBe("\u{1F680}\u{1F680}\u{1F680}\u{1F680}…");
      expect(visibleLength(after[0]!.text)).toBe(9);

      // The distinguishing assertion: the ascii segment must be trimmed all
      // the way to the floor, which only happens if shrinking continues
      // past the rocket segment parking. Under the `break` mutation this
      // segment stalls at "abcdefgh…" (width 9) instead.
      expect(after[1]!.text).toBe("abcdefg…");
      expect(visibleLength(after[1]!.text)).toBe(MIN_SHRUNK_TEXT);
    });
  });

  it("never strips the variation selector off an emoji-presentation heart when trimming", () => {
    // "❤️" is U+2764 (a text-presentation heart on its own, narrow) followed
    // by VS16 (U+FE0F), which requests the wide emoji presentation. Code-point
    // slicing removes the trailing "z" first, then reaches the VS16 and strips
    // it alone, leaving a bare U+2764 — a real corruption: the glyph flips
    // from a red emoji heart to a monochrome text heart.
    //
    // The trailing "z" is load-bearing here: it's what gives the code-point
    // loop a stopping point right after the VS16 is gone but before the base
    // heart is touched. A trailing character measures 1 column, so removing
    // it changes `visibleLength` by exactly 1 — a real, distinct width the
    // loop can stop on.
    //
    // A cluster with nothing after it (e.g. the ZWJ family or a flag,
    // exercised elsewhere in this file) can NOT distinguish cluster-slicing
    // from code-point-slicing at any overflow: `visibleLength` re-segments on
    // every call, and any partial remnant of the trailing cluster re-merges
    // (ZWJ) or measures the same (Regional Indicator pairs are typically
    // removed together) as the intact cluster, so the width never changes
    // until the whole cluster is gone — the code-point loop never gets a
    // reason to stop mid-cluster. Do not "simplify" this test back to a
    // trailing multi-part emoji with nothing after it; that shape cannot
    // fail under the code-point-slicing regression this test exists to catch.
    const heart = "\u{2764}\u{FE0F}";
    const outputs = [shrinkable(`feature/x${heart}z`)];

    const after1 = shrinkOutputs(outputs, 1)[0]!.text;
    expect(after1).toBe("feature/x…");

    const after2 = shrinkOutputs(outputs, 2)[0]!.text;
    expect(after2).toBe("feature/x…");

    const after3 = shrinkOutputs(outputs, 3)[0]!.text;
    expect(after3).toBe("feature/…");
  });
});
