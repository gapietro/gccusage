import { describe, it, expect } from "vitest";
import { stripAnsi, visibleLength } from "../utils/terminal.js";
import { truncateAnsi } from "../render/truncation.js";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;
const RESET = `${ESC}[0m`;

/** An OSC-8 hyperlink: 4 columns of visible text, wrapped in URL that draws none. */
const OSC8_OPENER = `${ESC}]8;;https://example.com${ST}`;
const OSC8 = `${OSC8_OPENER}link${ESC}]8;;${ST}`;

/**
 * Every escape class a terminal recognises, paired with the columns it draws.
 *
 * Issue #113: `stripAnsi` matched only SGR, so each of these counted its own
 * escape bytes as visible text — an OSC-8 hyperlink measured 37 columns for
 * the 4 it draws. The right-hand column is what a terminal actually advances
 * the cursor by, taken from the sequence definitions rather than from this
 * codebase's output.
 */
const MEASURED: Array<[name: string, input: string, columns: number]> = [
  ["SGR, the case that already worked", `${ESC}[31mred${RESET}`, 3],
  ["OSC-8 hyperlink, ST-terminated", OSC8, 4],
  ["OSC-8 hyperlink, BEL-terminated", `${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`, 4],
  ["OSC window title", `${ESC}]0;my window title${BEL}ok`, 2],
  ["CSI cursor up", `${ESC}[1Aok`, 2],
  ["CSI erase line, no parameters", `${ESC}[Kok`, 2],
  ["CSI erase display, then text", `${ESC}[2Jhome`, 4],
  ["CSI private mode, hide cursor", `${ESC}[?25lok`, 2],
  ["CSI scroll region, multiple parameters", `${ESC}[1;5rok`, 2],
  ["nF charset select", `${ESC}(Bok`, 2],
  ["two-character escape, full reset", `${ESC}cok`, 2],
  ["DCS string", `${ESC}Psome-device-string${ST}ok`, 2],
  ["APC string", `${ESC}_application${ST}ok`, 2],
  ["C0 carriage return", "abc\rdef", 6],
  ["C0 bell", `ab${BEL}c`, 3],
  ["C0 backspace", "ab\bc", 3],
  ["C0 shift out", "ab\u000ec", 3],
];

describe("visibleLength across every escape class", () => {
  it.each(MEASURED)("%s draws the columns it draws", (_name, input, columns) => {
    expect(visibleLength(input)).toBe(columns);
  });

  it("strips the escape and keeps the text", () => {
    expect(stripAnsi(`${ESC}]0;title${BEL}ok`)).toBe("ok");
    expect(stripAnsi(`${ESC}[?25lok`)).toBe("ok");
    expect(stripAnsi(OSC8)).toBe("link");
  });
});

describe("deliberate exclusions", () => {
  it("counts a tab as one column", () => {
    // A tab's real width depends on the cursor's position against the next tab
    // stop, which is not knowable statically. 1 is a floor — a tab is never
    // narrower — so it can only over-measure, never overflow the terminal.
    expect(visibleLength("a\tb")).toBe(3);
  });

  it("keeps newlines, which separate the two lines of the bar", () => {
    // Not decoration: `renderStatusline`'s callers split the output of
    // stripAnsi on "\n". Stripping LF as a zero-width control collapsed the
    // two-line bar into one 90-column line, and left four assertions in
    // default-layout-width.test.ts comparing against an empty second line.
    expect(stripAnsi("line one\nline two")).toBe("line one\nline two");
  });

  it("counts a bare ESC that opens nothing as one column", () => {
    expect(visibleLength(`ab${ESC}`)).toBe(3);
  });

  it("counts an incomplete escape as visible text", () => {
    // The safe direction, chosen deliberately: over-measuring truncates early
    // (cosmetic), under-measuring overflows the terminal (the bug class this
    // and #86 exist to close). A malformed sequence must never be able to make
    // the rest of the bar free.
    expect(visibleLength(`${ESC}]8;;https://example.com`)).toBe(24);
  });
});

describe("truncateAnsi honours its contract on non-SGR escapes", () => {
  const SAMPLES = MEASURED.map(([, input]) => input).concat([
    `${ESC}]8;;https://example.com`, // unterminated OSC
    `ab${ESC}`, // bare trailing ESC
    `${ESC}[2Jhome`,
  ]);

  it("never exceeds maxWidth, across a sweep of widths and escape classes", () => {
    for (const sample of SAMPLES) {
      for (let width = 2; width <= 40; width++) {
        const out = truncateAnsi(sample, width);
        expect(
          visibleLength(out),
          `${JSON.stringify(sample)} @ ${width}`,
        ).toBeLessThanOrEqual(width);
      }
    }
  });

  it("does not swallow visible text into a fake escape", () => {
    // `indexOf("m", i)` found the `m` of `home` and read `ESC[2Jhom` as one SGR
    // sequence costing 0 columns, so this returned the entire input plus an
    // ellipsis — longer than the string it was asked to shorten.
    const out = truncateAnsi(`${ESC}[2Jhome`, 3);
    expect(out).not.toContain("home");
    expect(visibleLength(out)).toBeLessThanOrEqual(3);
  });

  it("charges a zero-width control the same nothing visibleLength charges it", () => {
    // The width sweep cannot catch this on its own: charging CR a column makes
    // truncateAnsi cut EARLY, which still satisfies "<= maxWidth". Only the
    // exact cut point shows the two recognisers disagreeing — and disagreeing
    // recognisers are the root cause this fix exists to remove.
    expect(truncateAnsi(`abc\rdefgh`, 7)).toBe(`abc\rdef…${RESET}`);
  });

  it("charges a SECOND, ADJACENT zero-width control nothing too", () => {
    // Guards the recogniser against being made stateful. `.test()` on a
    // `g`-flagged regex advances `lastIndex` on a match, so the same character
    // matches on one call and not the next.
    //
    // Adjacency is the whole point, and `ab\rcd\refgh` does NOT catch it: the
    // check runs on every cluster, and any non-matching one in between fails
    // and resets `lastIndex` to 0, which leaves the next control measuring
    // correctly by accident. Only two controls in a row keep the stale index
    // alive long enough to charge the second a column it does not occupy.
    expect(truncateAnsi(`ab\r\rcdefgh`, 7)).toBe(`ab\r\rcdef…${RESET}`);
  });

  it("emits an OSC-8 URL whole or not at all", () => {
    // Cutting inside the URL emits an OSC sequence with no terminator, and the
    // terminal then consumes whatever follows as part of the string.
    for (let width = 2; width <= 12; width++) {
      const out = truncateAnsi(OSC8, width);
      if (out.includes(`${ESC}]8;;`)) {
        expect(out, `width ${width}`).toContain(OSC8_OPENER);
      }
    }
  });

  it("still preserves SGR colour and appends a reset", () => {
    const out = truncateAnsi(`${ESC}[31mredredredred${RESET}`, 6);
    expect(out).toContain(`${ESC}[31m`);
    expect(out.endsWith(RESET)).toBe(true);
  });
});
