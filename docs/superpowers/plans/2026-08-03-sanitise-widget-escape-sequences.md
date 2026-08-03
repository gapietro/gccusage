# Sanitise Terminal Control Sequences Out Of Widget Text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a `custom-command` (or any widget carrying text this tool did not author) from putting cursor-control, screen-erase, window-title or carriage-return bytes into a statusline that Claude Code renders inside its own Ink TUI. Issue #115.

**Architecture:** One new export, `sanitizeAnsi`, in `src/utils/terminal.ts` — the module that already owns the ECMA-48 escape grammar after #113. It reuses that module's `escapeLengthAt` to find sequence boundaries and keeps only SGR, dropping everything else. `src/render/renderer.ts` applies it to every `WidgetOutput.text` at both widget-collection sites, so no individual widget has to opt in.

**Tech Stack:** TypeScript, tsdown, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-sanitise-widget-escape-sequences-design.md` — read it before starting. It records *why* each rule is the way it is, and several of the rules look wrong without their reason.

## Global Constraints

- **Every commit that touches `src/` must run `npm run build` and stage `dist/index.js` with `git add -f dist/index.js`.** `dist/` is gitignored but force-tracked. `gccusage setup` points `statusLine.command` at that file, so a src-only commit leaves everyone who runs `git pull` on the old code. CI's `bundle-drift` job fails the build on byte-inequality.
- **Verify every new test by breaking what it guards.** Temporarily invert or delete the line of implementation the test covers, confirm the test fails, restore. A test that passes against a broken implementation is worse than no test. Do not skip this — see the project's `vacuous-tests` history.
- **Write ESC as `\u001b` in every source and test file.** Never paste a literal ESC byte into the repo. It is invisible in review, survives copy-paste unpredictably, and this plan's first draft lost several that way.
- **No new dependency.** `ansi-regex` is specifically rejected in `terminal.ts`'s existing comments (ReDoS advisory GHSA-93q8-gq69-wqmw on this pattern shape, against arbitrary shell output).
- **No config surface changes**, so `config-schema.json` must not move. If `src/__tests__/config-schema.test.ts` fails, something went wrong.
- Run `npm test` and `npm run typecheck` before every commit.
- Work on branch `fix/115-sanitize-widget-escapes`, which already exists and carries the spec commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/terminal.ts` (modify) | Gains `SGR_ONLY`, `RESET` and `sanitizeAnsi`. Already owns `ESCAPE_SEQUENCE`, `escapeLengthAt`, `isZeroWidthControl`, `stripAnsi`, `visibleLength`. |
| `src/render/renderer.ts` (modify) | Calls `sanitizeAnsi` on `output.text` at the two places a `WidgetOutput` enters the bar. |
| `src/__tests__/ansi-escapes.test.ts` (modify) | Home of the #113 grammar tests. Gains a `describe("sanitizeAnsi")` block; reuses its existing `ESC` / `BEL` / `ST` / `RESET` / `OSC8` constants. |
| `src/__tests__/renderer.test.ts` (modify) | Gains the bar-level tests: the acceptance criterion is about the rendered bar, not the helper. |

No file is created. No widget file is modified.

---

### Task 1: `sanitizeAnsi` in `terminal.ts`

**Files:**
- Modify: `src/utils/terminal.ts` (append after `visibleLength`)
- Test: `src/__tests__/ansi-escapes.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `escapeLengthAt(str, index): number`, `isZeroWidthControl(cluster): boolean`, `visibleLength(str): number` — all already exported from `src/utils/terminal.ts`.
- Produces: `sanitizeAnsi(str: string): string`, exported from `src/utils/terminal.ts`. Task 2 imports it by that exact name.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/ansi-escapes.test.ts`. That file already defines `ESC`, `BEL`, `ST`, `RESET` and `OSC8` at module scope — reuse them, do not redeclare. Add `sanitizeAnsi` to its existing `import { stripAnsi, visibleLength } from "../utils/terminal.js";` line.

```typescript
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
    ["OSC-8 hyperlink", OSC8],
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/ansi-escapes.test.ts`
Expected: FAIL — `sanitizeAnsi is not a function`, or a TypeScript import error naming `sanitizeAnsi`.

- [ ] **Step 3: Implement `sanitizeAnsi`**

Append to `src/utils/terminal.ts`, after `visibleLength`:

```typescript
/**
 * SGR alone: `ESC [`, digits/`;`/`:`, `m`. Anchored, and deliberately narrower
 * than "a CSI whose final byte is `m`".
 *
 * `ESCAPE_SEQUENCE` spells a CSI's parameter bytes `[0-?]`, per ECMA-48, and
 * that range includes the private markers `< = > ?`. So `ESC[>4;2m` ends in
 * `m` and would pass the obvious check — but it is xterm's `modifyOtherKeys`,
 * which reconfigures how the terminal reports keypresses. Letting a
 * `custom-command` do that is precisely the hazard #115 exists to close.
 *
 * `:` is admitted for T.416 subparameter forms (`38:2::10:20:30`), which real
 * tools emit for truecolour and underline styles. A private marker may only
 * appear as the FIRST parameter byte, so admitting `:` cannot smuggle one in.
 * Intermediate bytes are excluded too: `ESC[ m` is not SGR.
 *
 * This is a second pattern in a module whose whole point is that there is one
 * recogniser. It does not break that rule. `sanitizeAnsi` uses
 * `escapeLengthAt` — and only `escapeLengthAt` — to decide where a sequence
 * starts and ends; this pattern only classifies a span whose boundaries are
 * already fixed. Finding boundaries is the job that must never be duplicated.
 * Keep it anchored so it can only ever test a whole span.
 */
const SGR_ONLY = /^\u001b\[[0-9;:]*m$/;

const RESET = "\u001b[0m";

/**
 * `str` with every terminal control sequence removed except SGR colour.
 *
 * The other half of #113. That fix made non-SGR escapes *measure* correctly;
 * measuring them correctly does not stop them reaching the terminal. This
 * statusline is not written to a terminal the tool owns — Claude Code embeds
 * it in its own Ink-rendered TUI — so `ESC[2J`, `ESC[1A`, `ESC[?25l`, `ESC]0;`
 * or a bare `CR` corrupt a rendering this tool has no control over, on a
 * cadence of every render. Issue #115. Reachable through `custom-command`,
 * which puts arbitrary shell output in the bar.
 *
 * **Three rules here invert what the rest of this module does, each on
 * purpose:**
 *
 * - **An incomplete escape is dropped, not kept.** For measuring, a sequence
 *   the grammar cannot complete stays visible text: over-measuring truncates
 *   early, which is cosmetic, while under-measuring overflows the terminal.
 *   For emitting, keeping it is the attack — output ending in an unterminated
 *   `ESC[2` is completed into a screen-clear by the next literal `J` anywhere
 *   later in the bar, and the terminal does not care that the two halves came
 *   from different widgets. Only the ESC byte goes; the printable remainder
 *   stays and renders as literal text.
 * - **LF is dropped, though `stripAnsi` deliberately keeps it.** There, LF is
 *   structural: the bar is two lines and callers `split("\n")`. Here we are one
 *   layer down, on a single segment, before `renderFull` joins lines — so a LF
 *   can only break the bar's line structure from inside a segment.
 * - **TAB becomes one space rather than being dropped.** Its width is not
 *   knowable statically, so `ZERO_WIDTH_CONTROL_CLASS` excludes it and callers
 *   count it as 1 — a floor. One space makes that floor exact, and keeps the
 *   separation the tab was expressing instead of turning `foo⇥bar` into
 *   `foobar`.
 *
 * **OSC-8 hyperlinks are dropped**, which is the judgment call #115 flags.
 * Keeping them would mean parsing OSC parameters to separate `ESC]8;;uri` from
 * `ESC]0;title` — the allowlist stops being one sequence class and becomes a
 * parameter-level policy — and force-closing every link, since an unclosed one
 * leaks link state onto everything Claude Code draws after the bar. That is
 * real machinery for a capability nobody has asked for, and which only some
 * terminals render inside a statusline. To relax it, widen this one predicate.
 *
 * **A trailing reset is appended when any SGR survives.** `powerline.ts` wraps
 * each segment as `chalk.hex(fg).bgHex(bg)(" " + text + " ")`, and chalk closes
 * only fg (`ESC[39m`) and bg (`ESC[49m`) — never a full reset. So an unclosed
 * `ESC[7m` or `ESC[5m` survives past the segment, past the bar, and into
 * Claude Code's TUI: the same corruption class as `ESC[2J`, arriving through a
 * sequence we agreed to allow. The cost is the segment's trailing padding
 * column losing its background in powerline mode, which is already being paid
 * — a command that colours itself almost always emits its own `ESC[0m`.
 *
 * Text with no visible content collapses to `""`, so `renderer.ts` sees what it
 * already treats as a separator and cleans it away, rather than laying out a
 * bare padded segment with a separator on each side.
 */
export function sanitizeAnsi(str: string): string {
  let out = "";
  let sawSgr = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i]!;

    if (ch === "\u001b") {
      const length = escapeLengthAt(str, i);
      if (length === 0) {
        i += 1; // Stray ESC: drop the byte, keep whatever printable follows.
        continue;
      }
      const sequence = str.slice(i, i + length);
      if (SGR_ONLY.test(sequence)) {
        out += sequence;
        sawSgr = true;
      }
      i += length;
      continue;
    }

    if (ch === "\t") {
      out += " ";
    } else if (ch !== "\n" && !isZeroWidthControl(ch)) {
      out += ch;
    }
    i += 1;
  }

  if (visibleLength(out) === 0) return "";
  return sawSgr ? out + RESET : out;
}
```

Note on idempotence: a second pass sees `out + RESET`, keeps the SGR, sets `sawSgr` again, and appends another `RESET` — which would fail the idempotence test. It does not, because the trailing `RESET` from the first pass is itself SGR and is preserved, so the second pass produces `out + RESET + RESET`. **If that test fails, the fix is to not append when `out` already ends in `RESET`**, not to delete the test:

```typescript
  if (visibleLength(out) === 0) return "";
  if (!sawSgr || out.endsWith(RESET)) return out;
  return out + RESET;
```

Prefer this form from the start.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/ansi-escapes.test.ts`
Expected: PASS, including every pre-existing #113 test in the file.

- [ ] **Step 5: Verify the tests are not vacuous**

Make each mutation, run `npx vitest run src/__tests__/ansi-escapes.test.ts`, confirm the named test fails, then **restore the file exactly**. If a mutation leaves the suite green, the test is not testing what it claims and must be strengthened before moving on.

| Mutation | Test that must fail |
|---|---|
| Widen `SGR_ONLY` to `/^\u001b\[[0-?]*[ -\/]*m$/` | the `ESC[>4;2m`, `ESC[?1m` and `ESC[ m` rows of `drops %s` |
| Change the stray-ESC branch to `out += ch; i += 1;` | `drops a stray ESC…` and `cannot leave an ESC that a later segment could complete` |
| Drop the reset entirely: `return out;` | `appends exactly one reset when SGR survives` |
| Append the reset unconditionally | `appends no reset when no SGR survives` |
| Remove the `out.endsWith(RESET)` guard | `is idempotent` |
| Change the TAB branch to fall through to the drop | `replaces TAB with a single space` |
| Remove the `ch !== "\n"` guard | `drops LF, which stripAnsi deliberately keeps` |
| Delete the `visibleLength(out) === 0` early return | `collapses text with no visible content…` |

- [ ] **Step 6: Typecheck, full suite, build, commit**

```bash
npm run typecheck && npm test && npm run build
git add src/utils/terminal.ts src/__tests__/ansi-escapes.test.ts
git add -f dist/index.js
git commit -m "feat: add sanitizeAnsi, an SGR-only allowlist for untrusted text (#115)"
```

`npm test` must be fully green — `sanitizeAnsi` is not wired into anything yet, so any failure elsewhere is unrelated and must be investigated, not ignored.

---

### Task 2: Apply it to every widget output in `renderer.ts`

**Files:**
- Modify: `src/render/renderer.ts` (both widget-collection sites, plus the import)
- Test: `src/__tests__/renderer.test.ts`

**Interfaces:**
- Consumes: `sanitizeAnsi(str: string): string` from `../utils/terminal.js` (Task 1).
- Produces: no new export. Behavioural contract: after this task, no `WidgetOutput.text` reaches layout carrying a non-SGR escape.

**Context the implementer needs:**

`renderer.ts` collects widget output in exactly two places:

1. `collectWidgets` (~line 36) — used by `renderCompact`.
2. `renderFull`'s inline loop (~line 152).

Both must be changed. Changing one leaves the other exposed, and the compact path is the one that fires on a narrow terminal.

The call must go **after** `if (!output) continue;` and **before** `isSeparatorOutput(output)`. `isSeparatorOutput` returns true for `output.text.trim() === ""`, so ordering it this way is what makes an escapes-only command collapse into the existing separator cleanup instead of laying out as a bare padded segment. `renderFull` has no inline `isSeparatorOutput` call — `cleanSeparators` runs after its loop — but put the sanitise immediately after the null check there too, so both sites read identically.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/renderer.test.ts`. It already imports `renderStatusline` and `stripAnsi`, and defines `makeContext` / `makeSettings` — reuse them.

Two things about the harness:

- `custom-command` caches by command string in a module-level `Map` that outlives each test, so **every test below uses a distinct payload**, which makes the command string distinct.
- The command is built from `process.execPath`, not `printf`. `printf '\033…'` behaves differently across `/bin/sh` implementations; Node's `-e` is exact. The shell argument is single-quoted and the payload goes through `JSON.stringify`, which emits only double quotes and backslash escapes — so nothing inside can terminate the single-quoted argument.

```typescript
describe("widget text sanitising (#115)", () => {
  const ESC = "\u001b";

  /** A shell command that writes `payload` to stdout verbatim, portably. */
  function emit(payload: string): string {
    return `${process.execPath} -e 'process.stdout.write(${JSON.stringify(payload)})'`;
  }

  /**
   * Every escape in `bar` is SGR.
   *
   * Stronger than asserting one hazardous sequence is absent, and independent
   * of the implementation: it re-derives "escape" here rather than importing
   * the recogniser under test, so a bug in that recogniser cannot hide behind
   * it. chalk emits SGR and nothing else, so this holds for the whole bar.
   */
  function expectOnlySgr(bar: string): void {
    const escapes = bar.match(/\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|.)/g) ?? [];
    expect(escapes.filter((e) => !/^\u001b\[[0-9;:]*m$/.test(e))).toEqual([]);
  }

  function renderCommand(command: string): string {
    return renderStatusline(
      makeContext(),
      makeSettings({ lines: [{ widgets: [{ type: "custom-command", command }], flex: "left" }] }),
    );
  }

  const HAZARDS: Array<[name: string, sequence: string]> = [
    ["erase display", `${ESC}[2J`],
    ["cursor up", `${ESC}[1A`],
    ["cursor home", `${ESC}[H`],
    ["hide cursor", `${ESC}[?25l`],
    ["carriage return", "\r"],
    ["window title", `${ESC}]0;pwned`],
    ["modifyOtherKeys", `${ESC}[>4;2m`],
  ];

  it.each(HAZARDS)("a custom-command emitting %s cannot put it in the bar", (_name, sequence) => {
    const bar = renderCommand(emit(`${sequence}visible`));

    expect(bar).not.toContain(sequence);
    expectOnlySgr(bar);
    // Without this the test passes vacuously when the widget renders nothing at
    // all — "sanitised" and "absent" are different outcomes and only the first
    // is the fix.
    expect(stripAnsi(bar)).toContain("visible");
  });

  it("keeps SGR colour emitted by a custom-command", () => {
    const bar = renderCommand(emit(`${ESC}[31mred${ESC}[0m`));

    expect(bar).toContain(`${ESC}[31m`);
    expect(stripAnsi(bar)).toContain("red");
  });

  it("sanitises on the compact path too", () => {
    const bar = renderStatusline(
      makeContext({ terminalWidth: 40 }),
      makeSettings({
        compact: { mode: "always", threshold: 80 },
        lines: [
          {
            widgets: [{ type: "custom-command", command: emit(`${ESC}[2Jcompact`) }],
            flex: "left",
          },
        ],
      }),
    );

    expect(bar).not.toContain(`${ESC}[2J`);
    expectOnlySgr(bar);
    expect(stripAnsi(bar)).toContain("compact");
  });

  // Powerline mode, because it is the mode where a surviving empty segment is
  // unmistakable: every segment costs two padding spaces and a separator glyph.
  // The oracle is equality with the same bar rendered without the widget at
  // all — "contributes nothing" is the actual contract.
  it("contributes no segment for a command that emits only control sequences", () => {
    const powerline = { enabled: true, theme: "default", separator: "▶", separatorThin: "│" };
    const context = makeContext({ terminalWidth: 200 });

    const withNoise = renderStatusline(
      context,
      makeSettings({
        powerline,
        lines: [
          {
            widgets: [
              { type: "custom-text", text: "before" },
              { type: "custom-command", command: emit(`${ESC}[2J${ESC}[H`) },
              { type: "custom-text", text: "after" },
            ],
            flex: "left",
          },
        ],
      }),
    );

    const without = renderStatusline(
      context,
      makeSettings({
        powerline,
        lines: [
          {
            widgets: [
              { type: "custom-text", text: "before" },
              { type: "custom-text", text: "after" },
            ],
            flex: "left",
          },
        ],
      }),
    );

    expect(withNoise).toBe(without);
  });

  it("cannot be completed into a hazard by the text of a later widget", () => {
    const bar = renderStatusline(
      makeContext(),
      makeSettings({
        lines: [
          {
            widgets: [
              { type: "custom-command", command: emit(`${ESC}[2`) },
              { type: "custom-text", text: "Jam" },
            ],
            flex: "left",
          },
        ],
      }),
    );

    expectOnlySgr(bar);
    expect(stripAnsi(bar)).toContain("Jam");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/renderer.test.ts -t "#115"`
Expected: FAIL — the hazard sequences are present in the rendered bar.

**Check what fails before continuing.** If `expect(stripAnsi(bar)).toContain("visible")` is what fails, the harness is broken (the widget is not rendering at all) and must be fixed *now* — otherwise the `not.toContain` assertions will go green for the wrong reason once the implementation lands, and the whole block is vacuous.

- [ ] **Step 3: Wire the sanitiser into both collection sites**

In `src/render/renderer.ts`, add `sanitizeAnsi` to the existing import from `../utils/terminal.js`.

Add this helper next to `isSeparatorOutput`:

```typescript
/**
 * Widget text, with every terminal control sequence but SGR removed.
 *
 * Applied to EVERY widget rather than to `custom-command` alone. No widget
 * emits ANSI of its own — colour arrives later, in `powerline.ts`, from the
 * `fg`/`bg` fields — so a blanket pass cannot damage anything this codebase
 * generates, and it covers `git-branch`, `project`, `cwd` and `model`, which
 * all surface text this tool did not author. Requiring each widget to opt in
 * is the same shape of failure as "registered ≠ displayed". Issue #115.
 *
 * Callers must run this BEFORE `isSeparatorOutput`: text that sanitises down
 * to nothing has to reach that function's `text === ""` branch, or a command
 * emitting only escapes lays out as a bare padded segment with a separator on
 * each side.
 */
function sanitizeOutput(output: WidgetOutput): WidgetOutput {
  return { ...output, text: sanitizeAnsi(output.text) };
}
```

In `collectWidgets`:

```typescript
    const output = widget.render(context, config);
    if (!output) continue;
    const sanitized = sanitizeOutput(output);
    if (isSeparatorOutput(sanitized)) continue;
    results.push({ output: sanitized, priority: config.priority ?? 99 });
```

In `renderFull`'s inline loop:

```typescript
      const output = widget.render(context, widgetConfig);
      if (!output) continue;

      outputs.push(sanitizeOutput(output));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: PASS — the new `#115` block and every pre-existing renderer test.

- [ ] **Step 5: Verify the tests are not vacuous**

| Mutation | Test that must fail |
|---|---|
| Revert the `renderFull` site only, keeping `collectWidgets` | every `it.each` hazard row |
| Revert the `collectWidgets` site only, keeping `renderFull` | `sanitises on the compact path too` |
| Move `sanitizeOutput` in `collectWidgets` to after the `isSeparatorOutput` check | `contributes no segment for a command that emits only control sequences` |
| Make `sanitizeOutput` return `output` unchanged | every test in the block except `keeps SGR colour` |

Restore the file exactly after each. The first two rows are the important ones — they are the only thing proving *both* sites were changed, and a single-site fix is the most likely way this ships half-done.

Note the third row: `contributes no segment…` renders in full mode, which reaches `cleanSeparators` rather than `collectWidgets`. If that mutation leaves it green, add a compact-mode (`compact: { mode: "always", threshold: 80 }`) variant of the same test that does exercise `collectWidgets`, rather than striking the row.

- [ ] **Step 6: Typecheck, full suite, build, commit**

```bash
npm run typecheck && npm test && npm run build
git add src/render/renderer.ts src/__tests__/renderer.test.ts
git add -f dist/index.js
git commit -m "fix: strip terminal control sequences from widget text (#115)"
```

Watch two suites that render the default layout end to end and would catch an over-eager sanitiser: `src/__tests__/default-layout-width.test.ts` and `src/__tests__/widget-reality.test.ts`. If either moves, the sanitiser is eating something it should not — do not update their expectations to match.

---

### Task 3: End-to-end proof and PR

**Files:** none modified. Verification only.

- [ ] **Step 1: Prove it through the shipped bundle, not the test harness**

The tests exercise `renderStatusline`. This checks `dist/index.js`, which is what `statusLine.command` actually runs.

`loadSettings` reads `$XDG_CONFIG_HOME/gccusage/settings.json`, falling back to `$HOME/.config/gccusage/settings.json` (`getConfigDir` in `src/config/loader.ts:7`). `XDG_CONFIG_HOME` is the seam — no code change needed to point it at a throwaway config.

```bash
SCRATCH=$(mktemp -d)
mkdir -p "$SCRATCH/gccusage"
node -e '
  const fs = require("fs");
  const hostile = process.execPath +
    " -e \x27process.stdout.write("\\u001b[2J\\u001b[1A\\u001b[?25lPWNED\\r\x27 + "\x27)\x27";
  fs.writeFileSync(process.argv[1] + "/gccusage/settings.json", JSON.stringify({
    lines: [{ widgets: [{ type: "model" }, { type: "custom-command", command: hostile }] }],
  }, null, 2));
' "$SCRATCH"
cat "$SCRATCH/gccusage/settings.json"

printf '%s' '{"session_id":"e2e-115","cwd":"'"$PWD"'","model":{"id":"claude-opus-4-6","display_name":"Opus 4.6"},"cost":{"total_cost_usd":1.23},"context_window":{"used_percentage":12,"context_window_size":200000}}' \
  | XDG_CONFIG_HOME="$SCRATCH" node dist/index.js | cat -v
```

`cat -v` renders ESC as `^[`. Read the output and confirm:

- **No** `^[[2J`, `^[[1A`, `^[[?25l`, and no `^M` (that is CR).
- `PWNED` **is** present — the visible text survives; only the control bytes were removed.
- SGR colour codes (`^[[38;2;…m`) are present, so the sanitiser did not flatten the bar.

Then `rm -rf "$SCRATCH"`.

If the quoting above proves awkward in your shell, write the settings file with the `Write` tool instead — the point is the `XDG_CONFIG_HOME` + `dist/index.js` pairing, not the heredoc.

- [ ] **Step 2: Confirm the bundle is in sync**

```bash
npm run build && git status --porcelain dist/index.js
```

Expected: empty output. Anything else means a commit went out without its rebuild, and CI's `bundle-drift` job will fail.

- [ ] **Step 3: Re-read the acceptance criteria against the work**

From issue #115, all three must be demonstrably true:

1. A `custom-command` emitting `ESC[2J`, `ESC[1A`, `ESC[?25l` or `CR` cannot put those bytes in the rendered bar.
2. SGR colour from a command still survives.
3. The decision on OSC-8 is documented at the sanitiser, whichever way it goes.

Point at the specific test or comment satisfying each. If any cannot be pointed at, it is not done.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin fix/115-sanitize-widget-escapes
gh pr create --title "Sanitise terminal control sequences out of widget text (#115)"
```

The body must cover, in this order:

1. What was hazardous, and why the Ink-embedded context makes it worse than an ordinary statusline — the bar is redrawn on every render into a TUI this tool does not own.
2. The SGR-only allowlist, and specifically that "SGR" is narrower than "CSI ending in `m`" because `ESC[>4;2m` is `modifyOtherKeys`.
3. The OSC-8 decision, its cost, and the single predicate to widen if it is ever revisited.
4. The three inversions of `stripAnsi`'s rules — incomplete escape, LF, TAB — each with its reason.
5. That it applies to every widget rather than `custom-command` alone, and why that is free (no widget emits ANSI of its own).
6. `Closes #115.`

---

## Notes for the implementer

- **Do not "fix" `stripAnsi` to match `sanitizeAnsi`.** They disagree about incomplete escapes, LF and TAB, and every one of those disagreements is deliberate and documented. Making them agree reintroduces #113 or #86.
- **Do not move the sanitiser into `truncation.ts` or `powerline.ts`.** By the time text reaches those it has been measured and laid out; sanitising there would change widths after the layout that assumed them.
- **`AUDIT.md` is deliberately untracked.** Update it locally if you touch it; never stage it.
