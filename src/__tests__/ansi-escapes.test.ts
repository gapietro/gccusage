import { describe, it, expect } from "vitest";
import { sanitizeAnsi, stripAnsi, visibleLength } from "../utils/terminal.js";
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

describe("sanitizeAnsi", () => {
  // Issue #115. The bar is embedded in Claude Code's own Ink-rendered TUI, so
  // a sequence that moves the cursor or erases the screen corrupts a rendering
  // this tool does not own — on a cadence of every render.
  const DROPPED: Array<[name: string, input: string]> = [
    ["erase display", `${ESC}[2J`],
    ["erase line", `${ESC}[2K`],
    ["cursor up", `${ESC}[1A`],
    ["cursor home", `${ESC}[H`],
    ["hide cursor", `${ESC}[?25l`],
    ["window title, BEL-terminated", `${ESC}]0;pwned${BEL}`],
    ["window title, ST-terminated", `${ESC}]0;pwned${ST}`],
    ["full reset", `${ESC}c`],
    ["charset select", `${ESC}(B`],
    ["APC string", `${ESC}_payload${ST}`],
    ["carriage return", "\r"],
    ["bell", BEL],
    ["backspace", "\b"],
    ["line feed", "\n"],
    ["delete", "\u007f"],
    // These end in `m` but are not SGR. `ESC[>4;2m` is xterm's
    // modifyOtherKeys, which reconfigures how the terminal reports keypresses.
    ["private-marker CSI ending in m", `${ESC}[>4;2m`],
    ["private-mode CSI ending in m", `${ESC}[?1m`],
    ["CSI with intermediate byte ending in m", `${ESC}[ m`],
  ];

  it.each(DROPPED)("drops %s but keeps the text around it", (_name, input) => {
    expect(sanitizeAnsi(`a${input}b`)).toBe("ab");
  });

  // OSC-8 is not special-cased (that would be exactly the parameter-level
  // policy the function's docstring disclaims), so it is dropped the same
  // way as any other non-SGR escape: the ESC...ST/BEL wrapper bytes go, but
  // "link" is ordinary printable text sitting between two escapes, not part
  // of either one, so it survives — identically to how `stripAnsi(OSC8)`
  // already resolves to "link" above. The hazard (the escapes themselves)
  // is removed; only the human-readable label remains.
  it("drops the OSC-8 escapes but keeps the link's visible label text", () => {
    expect(sanitizeAnsi(`a${OSC8}b`)).toBe("alinkb");
  });

  const KEPT: Array<[name: string, input: string]> = [
    ["basic colour", `${ESC}[31m`],
    ["reset", RESET],
    ["empty-parameter SGR", `${ESC}[m`],
    ["256-colour", `${ESC}[38;5;42m`],
    ["truecolour", `${ESC}[38;2;10;20;30m`],
    ["T.416 subparameter truecolour", `${ESC}[38:2::10:20:30m`],
    ["bold", `${ESC}[1m`],
  ];

  it.each(KEPT)("keeps %s", (_name, input) => {
    expect(sanitizeAnsi(`a${input}b`)).toBe(`a${input}b${RESET}`);
  });

  it("appends exactly one reset when SGR survives", () => {
    expect(sanitizeAnsi(`${ESC}[31mred`)).toBe(`${ESC}[31mred${RESET}`);
  });

  it("appends no reset when no SGR survives", () => {
    expect(sanitizeAnsi("plain")).toBe("plain");
    expect(sanitizeAnsi(`plain${ESC}[2J`)).toBe("plain");
  });

  // The asymmetry with stripAnsi. For MEASURING, an escape the grammar cannot
  // complete stays visible text: over-measuring truncates early, which is
  // cosmetic, while under-measuring overflows the terminal. For EMITTING, that
  // same rule is the attack — a trailing unterminated `ESC[2` is completed into
  // a screen-clear by the next literal `J` anywhere later in the bar.
  it("drops a stray ESC the grammar cannot complete, keeping its printable tail", () => {
    expect(sanitizeAnsi(`branch${ESC}[2`)).toBe("branch[2");
  });

  it("cannot leave an ESC that a later segment could complete", () => {
    const bar = `${sanitizeAnsi(`a${ESC}[2`)}J`;
    expect(bar).not.toContain(ESC);
  });

  // TAB's width depends on the cursor's position against the next tab stop,
  // which is not knowable statically; terminal.ts counts it as 1 as a floor.
  // One space makes that floor exact and preserves the separation the tab meant.
  it("replaces TAB with a single space", () => {
    expect(sanitizeAnsi("a\tb")).toBe("a b");
  });

  // stripAnsi deliberately preserves LF because the bar is two lines and its
  // callers split on it. This runs one layer down, on a single segment, before
  // renderFull joins lines — so here a LF can only break the bar from inside.
  it("drops LF, which stripAnsi deliberately keeps", () => {
    expect(sanitizeAnsi("a\nb")).toBe("ab");
    expect(stripAnsi("a\nb")).toBe("a\nb");
  });

  // Otherwise a command emitting only escapes renders as a bare padded segment
  // with a separator on each side. Empty text is what renderer.ts already
  // treats as a separator and cleans away.
  it("collapses text with no visible content to the empty string", () => {
    expect(sanitizeAnsi(`${ESC}[31m${ESC}[0m`)).toBe("");
    expect(sanitizeAnsi(`${ESC}[2J`)).toBe("");
    expect(sanitizeAnsi("")).toBe("");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeAnsi("main ✓ $12.34")).toBe("main ✓ $12.34");
  });

  // The output must be a fixed point: sanitising an already-sanitised string
  // must not append a second reset or otherwise drift.
  it("is idempotent", () => {
    const once = sanitizeAnsi(`${ESC}[31mred${ESC}[2J`);
    expect(sanitizeAnsi(once)).toBe(once);
  });

  describe("8-bit C1 controls", () => {
    // U+009B is CSI and U+009D is OSC in their single-byte (8-bit) forms —
    // the same sequence classes as the 7-bit `ESC [` / `ESC ]` spellings
    // tested above, one byte shorter. `ESCAPE_SEQUENCE` only ever inspects
    // the 7-bit ESC-prefixed grammar, so before this fix these walked
    // straight through unrecognised. VTE-based terminals (GNOME Terminal,
    // Tilix, Terminator) parse C1 controls in UTF-8 mode, so this is not a
    // theoretical gap. Built with `String.fromCharCode` rather than a
    // `\u...` literal so the raw byte is visibly deliberate here, not a
    // typo.
    const CSI_C1 = String.fromCharCode(0x9b);
    const OSC_C1 = String.fromCharCode(0x9d);

    // Unlike the 7-bit forms, `sanitizeAnsi` has no grammar that recognises
    // a C1-introduced sequence as one unit — it only knows to drop the
    // single introducer byte (the same failsafe as the stray-ESC rule), so
    // the printable remainder after it survives as literal text rather than
    // vanishing with the rest of a recognised sequence.
    it("drops an 8-bit CSI introducer, leaving the erase-display payload as literal text", () => {
      expect(sanitizeAnsi(`a${CSI_C1}2Jb`)).toBe("a2Jb");
    });

    it("drops an 8-bit OSC introducer, leaving the window-title payload as literal text", () => {
      // The trailing BEL terminator is itself a C0 zero-width control and is
      // dropped by the existing `isZeroWidthControl` branch, not by this fix.
      expect(sanitizeAnsi(`a${OSC_C1}0;pwned${BEL}b`)).toBe("a0;pwnedb");
    });

    it("cannot let any 8-bit C1 control byte survive to reach the terminal", () => {
      for (let code = 0x80; code <= 0x9f; code++) {
        const out = sanitizeAnsi(`a${String.fromCharCode(code)}b`);
        for (const ch of out) {
          expect(
            ch.codePointAt(0)!,
            `U+${code.toString(16).padStart(4, "0")} produced ${JSON.stringify(out)}`,
          ).not.toBe(code);
        }
      }
    });
  });
});
