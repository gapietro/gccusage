# Terminal Width Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `getTerminalWidth()` report the real terminal width so compact `auto` works, the default bar stops truncating mid-word, and the README stops documenting a feature that cannot fire.

**Architecture:** Claude Code injects `COLUMNS` into the statusline subprocess environment (verified against the 2.1.220 binary). `getTerminalWidth()` reads `process.stdout.columns` first, then `COLUMNS`, then returns `undefined`. Unknown width propagates as a *decision* at each consumer — no padding, no truncation, no auto-compaction — rather than as a substitute number. The renderer derives `availableWidth = terminalWidth - STATUSLINE_GUTTER` from an empirically measured constant, and `renderCompact`'s hand-rolled segment-width arithmetic is replaced by measuring a real render.

**Tech Stack:** TypeScript, tsdown (bundler), vitest, valibot.

Spec: `docs/superpowers/specs/2026-08-01-terminal-width-design.md`
Issue: [#67](https://github.com/gapietro/gccusage/issues/67)

## Global Constraints

- **Every commit that touches `src/` must run `npm run build` and stage the bundle**: `git add -f dist/index.js`. `dist/` is gitignored but force-tracked, and `gccusage setup` points `statusLine.command` at it, so a src-only commit leaves everyone who `git pull`s running the old code.
- `npm test` must pass at the end of every task. `npm run typecheck` must pass at the end of every task that changes types.
- Tests that read `COLUMNS`, `HOME`, `XDG_CONFIG_HOME` or `XDG_CACHE_HOME` must set **and restore** them explicitly. vitest inherits the surrounding shell's environment; a test that does not control `COLUMNS` passes or fails by accident.
- `vitest.config.ts` pins `include` to `src/**/__tests__/**/*.test.ts` and `scripts/**/__tests__/**/*.test.ts`. A test file outside those roots silently never runs.
- Do not hardcode any width constant that has not been measured. Issue #67 exists because `|| 80` was a plausible guess nobody exercised.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Verify `COLUMNS` empirically and measure the statusline gutter

The whole plan rests on two claims read out of a disassembled binary: that Claude Code sets `COLUMNS` in the statusline subprocess, and that it reserves some columns beside the statusline text. This task proves the first and measures the second. **Do this task first** — if `COLUMNS` turns out not to be set, the rest of the plan is wrong and needs rework, not adjustment.

This is a manual procedure. It temporarily repoints `statusLine.command` in `~/.claude/settings.json`, the same pattern `src/__tests__/fixtures/real-payloads/capture.md` documents for payload capture.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-terminal-width-design.md` (record the measured values)

**Interfaces:**
- Consumes: nothing
- Produces: two measured integers used by Task 2 and Task 3 — whether `COLUMNS` is set, and `STATUSLINE_GUTTER` (columns reserved beside the bar)

- [ ] **Step 1: Back up the real settings file**

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak
```

Confirm the backup exists and is non-empty before continuing:

```bash
test -s ~/.claude/settings.json.bak && echo OK
```

- [ ] **Step 2: Write the ruler probe script**

The probe drains stdin (Claude Code writes the payload to it and will error if nothing reads it), records the environment it was given, and prints a ruler exactly `$COLUMNS` characters wide. The digit pattern repeats every 10, so the last visible character identifies the cut column by eye.

```bash
mkdir -p /tmp/gccusage-probe
cat > /tmp/gccusage-probe/ruler.sh <<'SH'
#!/bin/sh
cat > /dev/null
{
  echo "COLUMNS=${COLUMNS:-<unset>}"
  echo "LINES=${LINES:-<unset>}"
} > /tmp/gccusage-probe/env.txt
awk -v n="${COLUMNS:-80}" 'BEGIN{
  s = "";
  for (i = 1; i <= n; i++) s = s substr("1234567890", ((i - 1) % 10) + 1, 1);
  print s;
}'
SH
chmod +x /tmp/gccusage-probe/ruler.sh
```

- [ ] **Step 3: Smoke-test the probe before installing it**

Never install an untested statusline command — a broken one leaves no bar and no error.

```bash
echo '{}' | COLUMNS=40 /tmp/gccusage-probe/ruler.sh
```

Expected: exactly `1234567890123456789012345678901234567890` (40 characters), and `/tmp/gccusage-probe/env.txt` reads `COLUMNS=40`.

- [ ] **Step 4: Install the probe as the statusline**

Edit `~/.claude/settings.json` and set:

```json
"statusLine": { "type": "command", "command": "/tmp/gccusage-probe/ruler.sh" }
```

Leave every other key untouched.

- [ ] **Step 5: Measure**

Open a Claude Code session in a terminal, send any prompt to force a statusline refresh, then read off two things:

1. `cat /tmp/gccusage-probe/env.txt` — does it show a real `COLUMNS`, or `<unset>`?
2. The rendered ruler in the terminal — how many characters are actually visible before it is cut or wraps?

Record:
- `COLUMNS` as reported by the probe: `______`
- Visible ruler characters: `______`
- `STATUSLINE_GUTTER = COLUMNS - visible characters`: `______`

Repeat once at a different terminal width (resize the window and send another prompt) to confirm the gutter is a constant and not a proportion.

**If `env.txt` reports `COLUMNS=<unset>`:** stop. The binary reading was wrong or version-specific. Do not continue to Task 2 — reopen the design.

- [ ] **Step 6: Restore the real statusline immediately**

```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
rm -rf /tmp/gccusage-probe
```

Verify the bar renders normally again before moving on.

- [ ] **Step 7: Record the measurement in the spec**

In `docs/superpowers/specs/2026-08-01-terminal-width-design.md`, replace the "Unverified observation" section with the measured result: the Claude Code version, both `COLUMNS` values tried, the visible width at each, and the derived gutter. Delete the wording that calls the observation unproven.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-08-01-terminal-width-design.md
git commit -m "$(cat <<'EOF'
Record the measured statusline gutter (#67)

Confirms empirically that Claude Code sets COLUMNS in the statusline
subprocess environment, and measures the columns it reserves beside the
bar at two terminal widths.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Read the real width, and model unknown width as unknown

The type change ripples through every consumer, so the width source and the unknown-width handling land together — a commit with one but not the other does not compile.

**Files:**
- Modify: `src/utils/terminal.ts`
- Modify: `src/types/render-context.ts:24`
- Modify: `src/render/truncation.ts:3`
- Modify: `src/render/flex.ts:5-9`
- Modify: `src/render/renderer.ts:16-22`
- Create: `src/__tests__/terminal.test.ts`
- Create: `src/__tests__/statusline-width.test.ts`

**Interfaces:**
- Consumes: the confirmation from Task 1 that `COLUMNS` is set
- Produces:
  - `getTerminalWidth(): number | undefined` (`src/utils/terminal.ts`)
  - `RenderContext.terminalWidth: number | undefined`
  - `truncateAnsi(str: string, maxWidth: number | undefined): string`
  - `applyFlex(segments: string[], totalWidth: number | undefined, mode: FlexMode): string`

- [ ] **Step 1: Write the failing unit tests for `getTerminalWidth`**

Create `src/__tests__/terminal.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTerminalWidth } from "../utils/terminal.js";

// process.stdout.columns exists only on a tty.WriteStream. Under vitest stdout
// is a pipe, so there is usually no own property at all — capture whatever is
// there and put it back exactly, rather than assuming either shape.
const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
let originalEnvColumns: string | undefined;

function setStdoutColumns(value: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  originalEnvColumns = process.env["COLUMNS"];
  delete process.env["COLUMNS"];
  setStdoutColumns(undefined);
});

afterEach(() => {
  if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  else delete (process.stdout as { columns?: number }).columns;
  if (originalEnvColumns === undefined) delete process.env["COLUMNS"];
  else process.env["COLUMNS"] = originalEnvColumns;
});

describe("getTerminalWidth", () => {
  it("uses a live TTY width when stdout is a terminal", () => {
    setStdoutColumns(137);
    expect(getTerminalWidth()).toBe(137);
  });

  it("prefers the live TTY width over a stale exported COLUMNS", () => {
    setStdoutColumns(137);
    process.env["COLUMNS"] = "80";
    expect(getTerminalWidth()).toBe(137);
  });

  it("falls back to COLUMNS when stdout is a pipe", () => {
    process.env["COLUMNS"] = "212";
    expect(getTerminalWidth()).toBe(212);
  });

  it("is undefined when neither source is available", () => {
    expect(getTerminalWidth()).toBeUndefined();
  });

  it.each(["0", "-5", "abc", "", "80.5"])(
    "treats the malformed COLUMNS value %j as unknown",
    (value) => {
      process.env["COLUMNS"] = value;
      expect(getTerminalWidth()).toBeUndefined();
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/terminal.test.ts`
Expected: FAIL. The "undefined when neither source is available" and malformed-value cases return `80`; the `COLUMNS` fallback case returns `80` instead of `212`.

- [ ] **Step 3: Implement `getTerminalWidth`**

Replace the body in `src/utils/terminal.ts` (leave `stripAnsi` and `visibleLength` untouched):

```ts
/**
 * The terminal's width in columns, or `undefined` when it cannot be known.
 *
 * `process.stdout.columns` is undefined whenever stdout is not a TTY, and
 * Claude Code always pipes the statusline's stdout — the same reason
 * `powerline.ts` has to force `chalk.level = 3`. This returned `|| 80` for
 * every user in every terminal (issue #67).
 *
 * Claude Code compensates in its hook spawner: it reads `process.stdout.columns`
 * from its own process — which is a real TTY — and injects `COLUMNS` (and
 * `LINES`) into the child's environment on every spawn, so the value tracks
 * live terminal resizes. Verified against the 2.1.220 binary.
 *
 * The live TTY value is preferred when we have one: someone running `gccusage`
 * directly in a terminal has an accurate `stdout.columns`, while a
 * shell-exported `COLUMNS` can be stale.
 *
 * A malformed value degrades to `undefined` rather than to a coerced number,
 * because every consumer treats unknown as "leave the output alone" and a
 * wrong number silently mangles the bar.
 */
export function getTerminalWidth(): number | undefined {
  const fromTty = process.stdout.columns;
  if (typeof fromTty === "number" && Number.isInteger(fromTty) && fromTty > 0) {
    return fromTty;
  }

  const fromEnv = process.env["COLUMNS"];
  if (fromEnv === undefined || fromEnv.trim() === "") return undefined;
  const parsed = Number(fromEnv);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/terminal.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Widen the types and handle unknown at each consumer**

In `src/types/render-context.ts:24`, change the field. Keep the key required so no caller can silently omit it:

```ts
  /** True terminal width, or undefined when it cannot be determined. */
  terminalWidth: number | undefined;
```

In `src/render/truncation.ts`, change the signature and add the early return:

```ts
export function truncateAnsi(str: string, maxWidth: number | undefined): string {
  // Unknown width: return the line untouched. Claude Code truncates on its own
  // end, so an over-long line degrades to its behaviour, whereas truncating to
  // a guessed width destroys output that would have fit.
  if (maxWidth === undefined) return str;
  if (visibleLength(str) <= maxWidth) return str;
```

In `src/render/flex.ts`, change the signature and add the early return:

```ts
export function applyFlex(
  segments: string[],
  totalWidth: number | undefined,
  mode: FlexMode,
): string {
  const content = segments.join("");
  // Unknown width: there is nothing to justify against, so emit the content
  // left-aligned regardless of the configured mode.
  if (totalWidth === undefined) return content;
  const contentWidth = visibleLength(content);
```

In `src/render/renderer.ts:16-22`, teach `shouldCompact` about unknown. The explicit `always`/`never` modes must keep working, so the unknown check goes after them:

```ts
function shouldCompact(settings: Settings, terminalWidth: number | undefined): boolean {
  const compact = settings.compact;
  if (!compact) return false;
  const mode = compact.mode ?? "auto";
  if (mode === "always") return true;
  if (mode === "never") return false;
  // "auto" with no measurable width: never collapse the bar on a guess.
  if (terminalWidth === undefined) return false;
  return terminalWidth < (compact.threshold ?? 80);
}
```

- [ ] **Step 6: Run the full suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS. Existing tests pass `terminalWidth: 80` or `200`, which are still valid values.

- [ ] **Step 7: Write the end-to-end spawn test**

This is the test that would have caught the original bug. It must spawn a real child with a real pipe on stdout — a test that stubs `process.stdout.columns` in-process mocks away the exact condition that was wrong.

Create `src/__tests__/statusline-width.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripAnsi } from "../utils/terminal.js";

// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

/** A widget label wide enough that an 80-column budget must cut it. */
const WIDE_LABEL = "W".repeat(140);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-width-"));

  const configDir = path.join(dir, "config", "gccusage");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      powerline: { enabled: false },
      compact: { mode: "never" },
      lines: [{ widgets: [{ type: "custom-text", text: WIDE_LABEL }] }],
    }),
  );

  // Seed the pricing cache so the child never reaches the network. Without
  // this, fetchPricing waits out a 5s timeout per spawn whenever the network
  // is slow or blocked.
  const cacheDir = path.join(dir, "cache", "gccusage");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "pricing.json"),
    JSON.stringify({ timestamp: Date.now(), data: {} }),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runStatusline(columns: string | undefined): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  };
  if (columns === undefined) delete env["COLUMNS"];
  else env["COLUMNS"] = columns;

  // A distinct session id per call: the statusline cache keys on
  // (sessionId, costUsd) with a 5s TTL, so reusing one id would serve the
  // first render back for the second width and the test would pass blind.
  const sessionId = `width-test-${columns ?? "unset"}`;

  // stdio "pipe" on stdout is the point of this test: it reproduces the
  // condition under which process.stdout.columns is undefined.
  return execFileSync(process.execPath, [DIST], {
    input: JSON.stringify({ session_id: sessionId, cost: { total_cost_usd: 1 } }),
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe.skipIf(!distExists)("statusline width through a real pipe", () => {
  it("renders to the width COLUMNS advertises, not to 80", () => {
    const visible = stripAnsi(runStatusline("200")).trimEnd();
    expect(visible.length).toBeGreaterThan(80);
    expect(visible).toContain(WIDE_LABEL);
  });

  it("truncates to a narrow COLUMNS", () => {
    const visible = stripAnsi(runStatusline("40")).trimEnd();
    expect(visible.length).toBeLessThanOrEqual(40);
    expect(visible.endsWith("…")).toBe(true);
  });

  it("does not truncate when COLUMNS is absent", () => {
    const visible = stripAnsi(runStatusline(undefined)).trimEnd();
    expect(visible).toContain(WIDE_LABEL);
  });
});
```

- [ ] **Step 8: Build and run the spawn test**

The test runs against the committed bundle, so it needs a fresh build.

Run: `npm run build && npx vitest run src/__tests__/statusline-width.test.ts`
Expected: PASS, 3 tests.

If the suite reports the describe block as skipped, `dist/index.js` is missing — run `npm run build` and retry. A skipped result is not a pass.

- [ ] **Step 9: Confirm the test actually catches the bug**

Temporarily revert `getTerminalWidth` to `return process.stdout.columns || 80;`, rebuild, and rerun. The first and third tests must FAIL. Then restore the fix and rebuild. A regression test that never fails proves nothing.

Run: `npm run build && npx vitest run src/__tests__/statusline-width.test.ts`
Expected after restoring: PASS.

- [ ] **Step 10: Commit**

```bash
npm run build
git add src/utils/terminal.ts src/types/render-context.ts src/render/truncation.ts \
        src/render/flex.ts src/render/renderer.ts \
        src/__tests__/terminal.test.ts src/__tests__/statusline-width.test.ts
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Read the real terminal width from COLUMNS (#67)

process.stdout.columns is always undefined behind Claude Code's pipe, so
getTerminalWidth() returned the || 80 fallback for every user in every
terminal. Claude Code injects COLUMNS into the statusline subprocess
environment; read that, preferring a live TTY width when there is one.

Unknown width is now modelled as undefined and handled as a decision at
each consumer — no truncation, no flex padding, no auto-compaction —
rather than substituted with a guess.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Reserve the measured gutter

**Files:**
- Modify: `src/utils/terminal.ts`
- Modify: `src/render/renderer.ts` (`renderStatusline`, `renderLine`, `renderCompact`)
- Modify: `src/__tests__/terminal.test.ts`

**Interfaces:**
- Consumes: `STATUSLINE_GUTTER` value measured in Task 1; `getTerminalWidth()` from Task 2
- Produces: `availableWidth(terminalWidth: number | undefined): number | undefined` (`src/utils/terminal.ts`)

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/terminal.test.ts`. Replace `<MEASURED>` with the integer measured in Task 1, and the two `<...>` expectations with `200 - <MEASURED>` and `1`:

```ts
import { availableWidth, STATUSLINE_GUTTER } from "../utils/terminal.js";

describe("availableWidth", () => {
  it("subtracts the gutter Claude Code reserves beside the bar", () => {
    expect(availableWidth(200)).toBe(200 - STATUSLINE_GUTTER);
  });

  it("stays unknown when the terminal width is unknown", () => {
    expect(availableWidth(undefined)).toBeUndefined();
  });

  it("never returns a budget below one column", () => {
    expect(availableWidth(1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/terminal.test.ts`
Expected: FAIL with "does not provide an export named 'availableWidth'".

- [ ] **Step 3: Implement it**

Append to `src/utils/terminal.ts`. Replace `<MEASURED>` with the Task 1 value and fill the comment in with the real numbers — the comment is the record that this constant was measured rather than guessed:

```ts
/**
 * Columns Claude Code reserves beside the statusline text.
 *
 * Measured on Claude Code 2.1.220 by pointing `statusLine.command` at a ruler
 * script printing exactly `$COLUMNS` characters: at COLUMNS=<A> the terminal
 * showed <B> characters, and at COLUMNS=<C> it showed <D> — a constant
 * reserve, not a proportion. See issue #67 and the design spec.
 *
 * Do not adjust this by intuition. Re-measure with the same procedure.
 */
export const STATUSLINE_GUTTER = <MEASURED>;

/**
 * Columns the bar may actually occupy, or undefined when the terminal width is
 * unknown. Clamped to at least 1 so a pathologically narrow terminal cannot
 * hand `truncateAnsi` a zero or negative budget.
 */
export function availableWidth(terminalWidth: number | undefined): number | undefined {
  if (terminalWidth === undefined) return undefined;
  return Math.max(1, terminalWidth - STATUSLINE_GUTTER);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/terminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the budget in the renderer**

In `src/render/renderer.ts`, import the helper:

```ts
import { visibleLength, availableWidth } from "../utils/terminal.js";
```

Change `renderLine` to lay out against the budget rather than the raw terminal width:

```ts
  const budget = availableWidth(context.terminalWidth);

  let line: string;
  if (isPowerline && powerline) {
    // ...unchanged...
  } else {
    const segments = outputs.map((o) => colorize(o.text, o.fg, o.bg));
    line = applyFlex(segments, budget, flex);
  }

  return truncateAnsi(line, budget);
```

In `renderCompact`, replace `context.terminalWidth` in the fitting loop with the budget:

```ts
  const budget = availableWidth(context.terminalWidth);
```

and compare against `budget` instead of `context.terminalWidth`. When `budget` is `undefined`, every segment fits:

```ts
    if (budget !== undefined && usedWidth + segWidth > budget && fitted.length > 0) break;
```

Leave `shouldCompact` comparing against `context.terminalWidth`: the `threshold` option means "the terminal is narrower than N", which is a property of the terminal, not of our layout budget. Add that as a comment above the call in `renderStatusline`:

```ts
export function renderStatusline(context: RenderContext, settings: Settings): string {
  // The compact threshold is a statement about the terminal ("collapse below N
  // columns"), so it compares against the true width. Only layout — padding,
  // truncation, and compact fitting — works against the reduced budget.
  if (shouldCompact(settings, context.terminalWidth)) {
    return renderCompact(context, settings);
  }
  return renderFull(context, settings);
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

If `STATUSLINE_GUTTER` turned out to be non-zero, the spawn test from Task 2 that asserts `visible.length <= 40` still holds (the budget only shrinks), and the `>80` assertion holds with a 200-column terminal. If any other test fails on an off-by-gutter expectation, fix the expectation — do not weaken the clamp.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/utils/terminal.ts src/render/renderer.ts src/__tests__/terminal.test.ts
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Reserve the columns Claude Code keeps beside the bar (#67)

Layout now works against availableWidth() rather than the raw terminal
width. The gutter is measured, not estimated; the procedure and both
measurements are recorded beside the constant.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Measure the compact line instead of estimating it

`renderCompact` charges `visibleLength(text) + 2 + 3` per segment. The real powerline cost is `visibleLength(text) + 3` — 2 for the surrounding spaces plus exactly one separator glyph, since `layoutPowerline` emits `N-1` inner separators plus one closing separator. In plain mode the real cost is `visibleLength(text)` exactly: `renderLine` joins colorized segments with `""` and `collectWidgets` has already dropped separator widgets. The estimate is wrong in both modes, by different amounts. Correcting the constants would leave a second implementation of the layout in place, so replace it with a measurement of a real render.

**Files:**
- Modify: `src/render/renderer.ts` (`renderCompact`, add `measureLine`)
- Modify: `src/__tests__/renderer.test.ts`

**Interfaces:**
- Consumes: `availableWidth()` from Task 3; `renderLine(outputs, settings, context, flex)` as it exists in `src/render/renderer.ts`
- Produces: `measureLine(outputs: WidgetOutput[], settings: Settings, context: RenderContext): number` — module-private to `renderer.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/renderer.test.ts`:

```ts
import { visibleLength } from "../utils/terminal.js";

describe("compact fitting measures the real line", () => {
  const widgets = [
    { type: "custom-text", text: "alpha", priority: 1 },
    { type: "custom-text", text: "bravo", priority: 2 },
    { type: "custom-text", text: "charlie", priority: 3 },
    { type: "custom-text", text: "delta", priority: 4 },
  ];

  it.each([true, false])("fills the budget without overflowing it (powerline=%s)", (powerlineOn) => {
    const settings = makeSettings({
      lines: [{ widgets }],
      powerline: {
        enabled: powerlineOn,
        theme: "default",
        separator: "▶",
        separatorThin: "│",
      },
      compact: { mode: "always", threshold: 80 },
    });

    // Sweep every budget from "one segment barely fits" to "everything fits".
    for (let width = 10; width <= 60; width++) {
      const line = renderStatusline(makeContext({ terminalWidth: width }), settings);
      expect(visibleLength(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps a segment the old arithmetic would have dropped", () => {
    const settings = makeSettings({
      lines: [{ widgets }],
      powerline: {
        enabled: true,
        theme: "default",
        separator: "▶",
        separatorThin: "│",
      },
      compact: { mode: "always", threshold: 80 },
    });

    // Four segments of 5/5/7/5 characters cost 5+3 + 5+3 + 7+3 + 5+3 = 34
    // columns in powerline mode. The old estimate charged 2 more per segment,
    // i.e. 42, and so dropped the last segment at any budget below 42.
    const line = renderStatusline(makeContext({ terminalWidth: 40 }), settings);
    expect(stripAnsi(line)).toContain("delta");
  });
});
```

Note: `makeContext`'s `terminalWidth` is the *true* terminal width, so these budgets are reduced by `STATUSLINE_GUTTER` before fitting. The assertions are `<= width`, which holds either way.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: FAIL — "keeps a segment the old arithmetic would have dropped" fails because the over-charge drops `delta`.

- [ ] **Step 3: Replace the estimate with a measurement**

In `src/render/renderer.ts`, add above `renderCompact`:

```ts
/**
 * The width this line would occupy if nothing constrained it.
 *
 * Measured by rendering, not by arithmetic. `renderLine` with an unknown width
 * adds no padding and performs no truncation, so its visible length is the
 * natural width — which means this cannot disagree with the painter, because
 * it *is* the painter. The previous hand-rolled estimate charged a fixed
 * `+2 +3` per segment: wrong by 2 in powerline mode and by 5 in plain mode,
 * with nothing tying it to the layout it was predicting. See issue #67.
 */
function measureLine(
  outputs: WidgetOutput[],
  settings: Settings,
  context: RenderContext,
): number {
  return visibleLength(
    renderLine(outputs, settings, { ...context, terminalWidth: undefined }, "left"),
  );
}
```

Then replace the fitting loop in `renderCompact`:

```ts
  // Greedily add widgets until the line would exceed the budget
  const fitted: WidgetOutput[] = [];
  const budget = availableWidth(context.terminalWidth);

  for (const { output } of allWidgets) {
    const candidate = [...fitted, output];
    if (budget !== undefined && measureLine(candidate, settings, context) > budget && fitted.length > 0) {
      break;
    }
    fitted.push(output);
  }
```

Delete the now-unused `sepWidth` / `segWidth` / `usedWidth` locals.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/render/renderer.ts src/__tests__/renderer.test.ts
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Measure the compact line instead of estimating its width (#67)

renderCompact charged a fixed +2 +3 per segment, which is wrong by 2 in
powerline mode and by 5 in plain mode. Replace the arithmetic with a
render of the candidate line at unknown width, so the measurement is the
painter rather than a second implementation of it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Pin the default layout against real payloads

Issue #67 became binding because PR #66 added ~21 columns to line 2 and nothing measured it. This test measures it.

**Files:**
- Create: `src/__tests__/default-layout-width.test.ts`

**Interfaces:**
- Consumes: `contextFromFixture(fx, homeDir)` from `src/__tests__/fixtures/context-from-fixture.js`; `DEFAULT_SETTINGS` from `src/config/defaults.js`; `renderStatusline` from `src/render/renderer.js`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/default-layout-width.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderStatusline } from "../render/renderer.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { contextFromFixture } from "./fixtures/context-from-fixture.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import { stripAnsi } from "../utils/terminal.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };
import lowFixture from "./fixtures/real-payloads/fable5-1m-low.json" with { type: "json" };
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

/**
 * The width the default two-line layout must fit inside. Not arbitrary: it is
 * the narrowest terminal on which the defaults promise not to compact, i.e.
 * one column above the default compact threshold of 80. If a new default
 * segment pushes a line past this, the layout is too wide for the terminals it
 * claims to support — widen the bar's budget deliberately or drop a segment,
 * do not raise this number to make the test green.
 */
const SUPPORTED_WIDTH = 81;

const fixtures: RealPayloadFixture[] = [
  midFixture as unknown as RealPayloadFixture,
  lowFixture as unknown as RealPayloadFixture,
  earlyFixture as unknown as RealPayloadFixture,
];

describe("default layout width against real payloads", () => {
  it.each(fixtures.map((fx) => [fx.name, fx] as const))(
    "renders %s without truncating on a supported terminal",
    (_name, fx) => {
      const context = contextFromFixture(fx, "/home/testuser");
      const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);

      for (const line of stripAnsi(output).split("\n")) {
        expect(line).not.toContain("…");
      }
    },
  );

  it("renders the busiest realistic bar without truncating", () => {
    // vim-mode only appears when vim mode is enabled, and it is the segment
    // that pushed line 2 over the edge in #66. Force it on, with realistic
    // project and branch names rather than the fixture's short placeholders.
    const fx = midFixture as unknown as RealPayloadFixture;
    const base = contextFromFixture(fx, "/home/testuser");
    const context = {
      ...base,
      terminalWidth: SUPPORTED_WIDTH,
      stdin: {
        ...base.stdin,
        vim: { mode: "NORMAL" },
      },
    } as typeof base;

    const output = renderStatusline(context, DEFAULT_SETTINGS);
    for (const line of stripAnsi(output).split("\n")) {
      expect(line).not.toContain("…");
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/__tests__/default-layout-width.test.ts`

Expected: the busiest-bar case FAILS — line 2 with vim-mode measures roughly 84 columns and truncates at an 81-column budget. That failure is the real, currently-shipping defect, now measured.

- [ ] **Step 3: Report the measurement before changing anything**

Record the actual rendered width of each line for the failing case. Do **not** raise `SUPPORTED_WIDTH` and do not remove a default segment on your own judgment — the layout is the user's call. Bring the number back and ask which of these they want:

1. Accept truncation on 81-column terminals and lower `SUPPORTED_WIDTH` to the measured width, documenting the narrowest supported terminal.
2. Drop or shorten a default segment on line 2 so it fits in 81 columns.
3. Raise the default `compact.threshold` so narrow terminals collapse to one line before line 2 would truncate.

- [ ] **Step 4: Apply the chosen resolution and make the test pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build
git add src/__tests__/default-layout-width.test.ts
git add -f dist/index.js
# plus any default-layout file the chosen resolution touched
git commit -m "$(cat <<'EOF'
Pin the default layout's width against real payloads (#67)

The busiest realistic bar — line 2 with vim-mode active — is measured
against the narrowest terminal the defaults promise not to compact on.
This is the measurement PR #66 lacked when it added the project segment.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Correct the README and verify end to end

**Files:**
- Modify: `README.md:141-143`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Replace the compact-mode description**

`README.md:141-143` currently reads:

```markdown
### Compact mode

Automatically collapses to a single line on narrow terminals:
```

Replace those three lines with a description of the actual rule:

```markdown
### Compact mode

Collapses both lines into a single line when the terminal is narrower than
`threshold` columns (default 80), keeping segments in `priority` order —
lower numbers survive. The terminal width comes from the `COLUMNS` variable
Claude Code sets when it runs the statusline; if it is unavailable, `auto`
never collapses the bar.
```

Leave the JSON example that follows at line 145 unchanged.

- [ ] **Step 2: Verify the claim against the code**

Read `shouldCompact` in `src/render/renderer.ts` and confirm every sentence of the new text is true of it: threshold default 80, `auto` returns false on unknown width, priority ascending keeps first. Fix the prose, not the code, if they disagree.

- [ ] **Step 3: Run the full verification**

```bash
npm test && npm run typecheck && npm run build
```

Expected: all suites PASS, typecheck clean, build succeeds.

Confirm the spawn test ran rather than skipping:

Run: `npx vitest run src/__tests__/statusline-width.test.ts --reporter=verbose`
Expected: 3 tests PASS, none skipped.

- [ ] **Step 4: Verify against the live statusline**

Rebuild, clear the statusline cache so a stale bar is not served, and look at the real bar in a wide terminal:

```bash
npm run build
rm -f ~/.cache/gccusage/statusline-cache.json
```

Send a prompt in a Claude Code session on a terminal wider than 100 columns. Line 2 must render complete, with no trailing `…`. Then narrow the terminal below 80 columns and send another prompt: the bar must collapse to a single line. Both were impossible before this change.

- [ ] **Step 5: Commit**

```bash
git add README.md
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Describe what compact mode actually does (#67)

The README claimed automatic collapse on narrow terminals, which could
never fire while the width was pinned at 80. State the real rule and
where the width comes from.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Confirm the bundle is current**

A src-only commit ships nothing to anyone who `git pull`s. Verify the working tree is clean after a fresh build:

```bash
npm run build
git status --porcelain
```

Expected: empty output. If `dist/index.js` shows as modified, an earlier task committed source without its bundle — amend or add a follow-up commit staging it with `git add -f dist/index.js`.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `getTerminalWidth(): number \| undefined`, TTY-then-COLUMNS precedence | 2 |
| Malformed `COLUMNS` treated as unknown | 2 |
| `RenderContext.terminalWidth` widened | 2 |
| Unknown → no truncation / no flex padding / no auto-compact | 2 |
| `STATUSLINE_GUTTER` measured, not guessed | 1, 3 |
| `availableWidth = Math.max(1, width - gutter)` | 3 |
| Reserve applied at the render layer, not in `getTerminalWidth` | 3 |
| Compact threshold stays 80, compared against true width | 3 |
| Measure-by-rendering replaces the segment estimate | 4 |
| `getTerminalWidth` unit tests controlling `COLUMNS` | 2 |
| End-to-end spawn test with a piped stdout | 2 |
| Natural-width property (no padding, no truncation at unknown width) | 4 (swept in the fitting test) |
| Real-payload width regression | 5 |
| README correction | 6 |
| Build + stage `dist/index.js` on every src commit | Global constraint, every task |

**Type consistency:** `getTerminalWidth(): number | undefined`, `availableWidth(number | undefined): number | undefined`, `truncateAnsi(string, number | undefined)`, `applyFlex(string[], number | undefined, FlexMode)`, `shouldCompact(Settings, number | undefined)`, `measureLine(WidgetOutput[], Settings, RenderContext): number`. `RenderContext.terminalWidth` is `number | undefined` throughout; the key stays required so no construction site can omit it.

**Known open decision:** Task 5 Step 3 stops for a layout decision rather than guessing. That is deliberate — how wide the shipped default bar should be is the user's call, not the implementer's.
