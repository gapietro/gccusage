# Derived Auto-Compact Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `compact-countdown`'s guessed 16.5% buffer with the rule derived from the Claude Code binary — auto-compact fires at `windowSize − 33,000` tokens — and make `context-percent` colour from the same point.

**Architecture:** A new `src/utils/autocompact.ts` owns the rule and the two alert bands. `deriveContextUsage` gains an exact `usedTokens` field so both widgets do their maths in token space instead of an integer percentage. Both widgets then read their colours from the shared constants, so they change on the same turn at any window size.

**Tech Stack:** TypeScript, vitest, tsdown.

**Spec:** `docs/superpowers/specs/2026-07-31-autocompact-threshold-design.md`
**Issue:** [#37](https://github.com/gapietro/gccusage/issues/37)

## Global Constraints

- **Every commit touching `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`.** `dist/` is gitignored but force-tracked; `gccusage setup` points `statusLine.command` at `dist/index.js`, so a src-only commit leaves `git pull` upgraders running the old code.
- Full test command: `npm test` (vitest run). Single file: `npx vitest run src/__tests__/<file>.ts`.
- Type check with `npm run typecheck` before each commit.
- `AUTOCOMPACT_RESERVE` is 33,000; `AMBER_TOKENS` is 20,000; `RED_TOKENS` is 5,000. These exact values appear in several tasks — do not round or rename them.
- Widget alert colours are fixed and deliberately distinct between the two widgets: `compact-countdown` uses `#b8860b` (amber) / `#a01822` (red); `context-percent` uses `#a67c00` (amber) / `#c01c28` (red). Never unify them — the difference is what keeps the two adjacent segments distinguishable.

---

### Task 1: The auto-compact rule module

**Files:**
- Create: `src/utils/autocompact.ts`
- Test: `src/__tests__/autocompact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AUTOCOMPACT_RESERVE: number` (33_000)
  - `AMBER_TOKENS: number` (20_000)
  - `RED_TOKENS: number` (5_000)
  - `compactThresholdTokens(windowSize: number): number | null`
  - `tokensUntilCompact(usedTokens: number, windowSize: number): number | null`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/autocompact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  AUTOCOMPACT_RESERVE,
  AMBER_TOKENS,
  RED_TOKENS,
  compactThresholdTokens,
  tokensUntilCompact,
} from "../utils/autocompact.js";

describe("compactThresholdTokens", () => {
  it("reserves a fixed 33k below the window", () => {
    expect(AUTOCOMPACT_RESERVE).toBe(33_000);
    expect(compactThresholdTokens(200_000)).toBe(167_000);
    expect(compactThresholdTokens(1_000_000)).toBe(967_000);
  });

  // The old constant was a fraction (1 - 0.165). It happened to be exact at
  // 200k and 132k tokens early at 1M, which is why it survived review.
  it("is not a fixed fraction of the window", () => {
    expect(compactThresholdTokens(200_000)! / 200_000).toBeCloseTo(0.835, 10);
    expect(compactThresholdTokens(1_000_000)! / 1_000_000).toBeCloseTo(0.967, 10);
  });

  it("returns null when the window is too small to model", () => {
    expect(compactThresholdTokens(33_000)).toBeNull();
    expect(compactThresholdTokens(10_000)).toBeNull();
    expect(compactThresholdTokens(0)).toBeNull();
  });

  it("returns null for a non-finite window", () => {
    expect(compactThresholdTokens(Number.NaN)).toBeNull();
    expect(compactThresholdTokens(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("tokensUntilCompact", () => {
  it("counts down to the threshold", () => {
    expect(tokensUntilCompact(0, 200_000)).toBe(167_000);
    expect(tokensUntilCompact(50_000, 200_000)).toBe(117_000);
    expect(tokensUntilCompact(70_000, 1_000_000)).toBe(897_000);
  });

  it("lands exactly on the band boundaries", () => {
    expect(AMBER_TOKENS).toBe(20_000);
    expect(RED_TOKENS).toBe(5_000);
    expect(tokensUntilCompact(147_000, 200_000)).toBe(AMBER_TOKENS);
    expect(tokensUntilCompact(162_000, 200_000)).toBe(RED_TOKENS);
    expect(tokensUntilCompact(947_000, 1_000_000)).toBe(AMBER_TOKENS);
    expect(tokensUntilCompact(962_000, 1_000_000)).toBe(RED_TOKENS);
  });

  it("clamps to zero past the threshold", () => {
    expect(tokensUntilCompact(167_000, 200_000)).toBe(0);
    expect(tokensUntilCompact(190_000, 200_000)).toBe(0);
  });

  it("returns null when the window is too small to model", () => {
    expect(tokensUntilCompact(1_000, 20_000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/autocompact.test.ts`
Expected: FAIL — cannot resolve `../utils/autocompact.js`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/autocompact.ts`:

```ts
/**
 * Auto-compact prediction.
 *
 * Derived from the shipped Claude Code binary (VERSION "2.1.220",
 * BUILD_TIME 2026-07-24), not from a measured session. The relevant
 * de-minified functions:
 *
 *   CSe(model, setting) = aY(...).window - Math.min(maxOutputTokens, 20000)
 *   Sfo(eff)            = eff - 13000
 *   uMu(tokens, eff)    = tokens >= Sfo(eff) ? "compact" : ...
 *
 * `cst()` gives a default max_output_tokens of 32000, so that Math.min always
 * clamps to 20000 for current models. The threshold is therefore a fixed token
 * reserve, not a fraction of the window. The same binary corroborates this with
 * a hardcoded precompute default of 967000 for a 1M window (1_000_000 - 33_000).
 * See issue #37.
 *
 * Assumes Claude Code's defaults: auto-compact enabled and `autoCompactWindow`
 * unset. Neither is visible in the statusline payload, so a user who changes
 * either will see these predictions miss — `autoCompactWindow` makes compaction
 * fire earlier than predicted, and `autoCompactEnabled: false` means it never
 * fires at all.
 */

/** Output headroom Claude Code holds back: min(maxOutputTokens, 20_000). */
const OUTPUT_RESERVE = 20_000;

/** Fixed compaction reserve, on top of the output headroom. */
const COMPACT_RESERVE = 13_000;

/** Total tokens reserved below the window size. */
export const AUTOCOMPACT_RESERVE = OUTPUT_RESERVE + COMPACT_RESERVE;

/** Amber band: Claude Code's own "warn" level sits 20k before the threshold. */
export const AMBER_TOKENS = 20_000;

/** Red band: the last warning before compaction. */
export const RED_TOKENS = 5_000;

/**
 * Token count at which auto-compact fires.
 *
 * Null when the window is too small for the reserve to make sense — callers
 * should fall back rather than render a negative countdown.
 */
export function compactThresholdTokens(windowSize: number): number | null {
  if (!Number.isFinite(windowSize) || windowSize <= AUTOCOMPACT_RESERVE) return null;
  return windowSize - AUTOCOMPACT_RESERVE;
}

/** Tokens left before auto-compact, clamped at zero. Null when unmodellable. */
export function tokensUntilCompact(usedTokens: number, windowSize: number): number | null {
  const threshold = compactThresholdTokens(windowSize);
  if (threshold === null) return null;
  return Math.max(0, Math.round(threshold - usedTokens));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/autocompact.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/utils/autocompact.ts src/__tests__/autocompact.test.ts
git add -f dist/index.js
git commit -m "Add the derived auto-compact threshold module (#37)"
```

---

### Task 2: `deriveContextUsage` gains `usedTokens`

**Files:**
- Modify: `src/utils/context-usage.ts`
- Test: `src/__tests__/context-usage.test.ts` (existing — assertions must be updated)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ContextUsage` gains `usedTokens: number | null`. `ratio` and `windowSize` keep their current meaning and derivation exactly.

Note for the implementer: every existing `toEqual({ ratio, windowSize })` in the test file fails once the new field exists. That is expected — update each one rather than loosening the assertion to `toMatchObject`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/context-usage.test.ts`, inside the existing `describe("deriveContextUsage", ...)` block:

```ts
  it("reports exact tokens from current_usage, including output", () => {
    // Claude Code's own compaction check sums input + cache_creation +
    // cache_read + output (dIe); used_percentage omits output and is rounded
    // to a whole percent, so current_usage is the more faithful source.
    const usage = deriveContextUsage({
      context_window: {
        used_percentage: 25,
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 30_000,
          output_tokens: 5_000,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 5_000,
        },
      },
    });
    expect(usage!.usedTokens).toBe(50_000);
  });

  it("prefers current_usage over the reported percentage for usedTokens", () => {
    // ratio still comes from used_percentage — it is what matches Claude Code's
    // own /context display — but usedTokens takes the exact breakdown.
    const usage = deriveContextUsage({
      context_window: {
        used_percentage: 25,
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 100_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    expect(usage!.ratio).toBe(0.25);
    expect(usage!.usedTokens).toBe(100_000);
  });

  it("derives usedTokens from the ratio when current_usage is absent", () => {
    const usage = deriveContextUsage({
      context_window: { used_percentage: 25, context_window_size: 200_000 },
    });
    expect(usage!.usedTokens).toBe(50_000);
  });

  it("leaves usedTokens null when no window size is reported", () => {
    const usage = deriveContextUsage({ context_window: { used_percentage: 25 } });
    expect(usage!.usedTokens).toBeNull();
  });
```

Then update the existing `toEqual` assertions in the same file to include the new field:

| Test (existing name) | New expected object |
|---|---|
| "prefers remaining_percentage" | `{ ratio: 0.07, windowSize: 1_000_000, usedTokens: 70_000 }` |
| "falls back to used_percentage" | `{ ratio: 0.25, windowSize: 200_000, usedTokens: 50_000 }` |
| "remaining_percentage beats used_percentage when both are present" | `{ ratio: 0.07, windowSize: 1_000_000, usedTokens: 70_000 }` |
| "returns a null windowSize when the size is absent" | `{ ratio: 0.25, windowSize: null, usedTokens: null }` |
| "falls back to summing current_usage" | `{ ratio: 0.25, windowSize: 200_000, usedTokens: 50_000 }` |
| "used_percentage beats current_usage when both are present" | `{ ratio: 0.25, windowSize: 200_000, usedTokens: 100_000 }` |
| "supports the legacy numeric context_window with token_usage" | `{ ratio: 0.25, windowSize: 200_000, usedTokens: 50_000 }` |

The last row is the one to read twice: `ratio` stays 0.25 from `used_percentage` while `usedTokens` becomes 100_000 from `current_usage`. That divergence is intended and is what the second new test above pins.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/context-usage.test.ts`
Expected: FAIL — `usedTokens` is undefined on the returned object.

- [ ] **Step 3: Write the implementation**

In `src/utils/context-usage.ts`, replace the `ContextUsage` interface and the body of `deriveContextUsage`:

```ts
export interface ContextUsage {
  /** Fraction of the context window consumed, 0..1. */
  ratio: number;
  /** Window size in tokens, or null when stdin did not report one. */
  windowSize: number | null;
  /**
   * Tokens occupying the window: exact when stdin reported the breakdown,
   * otherwise derived from `ratio`, otherwise null.
   *
   * Prefer this over `ratio` for token maths. `used_percentage` is a whole
   * number, which at a 1M window quantises to 10k-token steps — against a
   * 33k-token compaction budget that is up to +/-5k of error.
   */
  usedTokens: number | null;
}
```

Add this helper above `deriveContextUsage`:

```ts
function withTokens(
  ratio: number,
  windowSize: number | null,
  exact: number | undefined,
): ContextUsage {
  const usedTokens =
    exact ?? (windowSize !== null ? Math.round(ratio * windowSize) : null);
  return { ratio, windowSize, usedTokens };
}
```

Then rewrite the body (keeping the existing doc comment above the function):

```ts
export function deriveContextUsage(stdin: StatusJson): ContextUsage | null {
  const cw = stdin.context_window;

  if (typeof cw === "object" && cw !== null) {
    const windowSize = cw.context_window_size ?? null;
    // Exact when present, regardless of which field supplies the ratio.
    const exact = cw.current_usage ? sumTokens(cw.current_usage) : undefined;

    // remaining_percentage accounts for all tokens (input, output, system).
    if (cw.remaining_percentage != null) {
      return withTokens((100 - cw.remaining_percentage) / 100, windowSize, exact);
    }
    if (cw.used_percentage != null) {
      return withTokens(cw.used_percentage / 100, windowSize, exact);
    }
    if (exact !== undefined && windowSize && windowSize > 0) {
      return withTokens(exact / windowSize, windowSize, exact);
    }
    return null;
  }

  // Legacy format: context_window is a plain number of tokens.
  if (typeof cw === "number" && cw > 0) {
    const usage = stdin.token_usage;
    if (!usage) return null;
    const exact = sumTokens(usage);
    return withTokens(exact / cw, cw, exact);
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/context-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `src/__tests__/widgets.test.ts` may still pass here — the widgets have not changed yet. If anything else fails, it is a real regression; fix before committing.

- [ ] **Step 6: Type check and commit**

```bash
npm run typecheck
npm run build
git add src/utils/context-usage.ts src/__tests__/context-usage.test.ts
git add -f dist/index.js
git commit -m "Expose exact context tokens from deriveContextUsage (#37)"
```

---

### Task 3: `compact-countdown` uses the derived threshold

**Files:**
- Modify: `src/widgets/compact-countdown.ts`
- Test: `src/__tests__/widgets.test.ts` (existing `compactCountdownWidget` describe block)

**Interfaces:**
- Consumes: `tokensUntilCompact`, `AMBER_TOKENS`, `RED_TOKENS` from Task 1; `usedTokens` from Task 2.
- Produces: no new exports. Rendered text and colours are unchanged in shape (`~Nk left`, `Compact imminent!`).

- [ ] **Step 1: Update the existing tests that encode the old rule**

In `src/__tests__/widgets.test.ts`, three existing tests assert the old behaviour and must change:

Replace the expectation in the 1M-window test (currently `expect(result!.text).toBe("~765.0k left")`):

```ts
    // 7% of 1M is 70k used; the threshold is 967k, so 897k remains. The old
    // 83.5% constant put the threshold at 835k and reported 765k.
    expect(result!.text).toBe("~897.0k left");
```

Replace the whole `it("turns amber under 25% headroom", ...)` test with:

```ts
  it("turns amber exactly 20k before the threshold", () => {
    // 73.5% of 200k is 147k used; the threshold is 167k, so 20k remains —
    // Claude Code's own warn level, and the boundary is inclusive.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 73.5, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~20.0k left");
    expect(result!.bg).toBe("#b8860b");
  });

  it("keeps the configured background just outside the amber band", () => {
    // 70% of 200k is 140k used, leaving 27k — comfortably above the band.
    // The old fraction-based rule called this amber.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 70, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~27.0k left");
    expect(result!.bg).toBe("#1a5fb4");
  });
```

Replace the whole `it("turns red under 10% headroom", ...)` test with:

```ts
  it("turns red exactly 5k before the threshold", () => {
    // 81% of 200k is 162k used, leaving 5k. Inclusive boundary.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 81, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~5.0k left");
    expect(result!.bg).toBe("#a01822");
  });

  it("is amber, not red, at 7k remaining", () => {
    // 80% of 200k is 160k used, leaving 7k — inside amber, outside red.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 80, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~7.0k left");
    expect(result!.bg).toBe("#b8860b");
  });
```

Then add one new test at the end of the `compactCountdownWidget` describe block:

```ts
  it("scales the bands to a 1M window instead of a fixed fraction", () => {
    // 94.7% of 1M is 947k used, leaving 20k — amber. Under the old rule this
    // was long past "Compact imminent!", 112k tokens too early.
    const amber = compactCountdownWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 94.7, context_window_size: 1_000_000 } },
      }),
      { type: "compact-countdown", bg: "#1a5fb4" },
    );
    expect(amber!.text).toBe("~20.0k left");
    expect(amber!.bg).toBe("#b8860b");

    const imminent = compactCountdownWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 96.7, context_window_size: 1_000_000 } },
      }),
      { type: "compact-countdown", bg: "#1a5fb4" },
    );
    expect(imminent!.text).toBe("Compact imminent!");
  });
```

The remaining tests in the block (`~117.0k left` from `used_percentage`, from `current_usage`, and from the legacy window; `~167.0k left` at 0%; both null cases; both "Compact imminent!" cases at 83.5% and 90%) are correct under the new rule and must keep passing unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/widgets.test.ts`
Expected: FAIL on the amber/red boundary tests and the 1M tests — the widget still uses the 16.5% fraction.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/widgets/compact-countdown.ts`:

```ts
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";
import { tokensUntilCompact, AMBER_TOKENS, RED_TOKENS } from "../utils/autocompact.js";

export const compactCountdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    // Without a window size a ratio cannot be turned into a token count.
    if (!usage || !usage.windowSize || usage.usedTokens === null) return null;

    const remaining = tokensUntilCompact(usage.usedTokens, usage.windowSize);
    if (remaining === null) return null;

    if (remaining <= 0) {
      return { text: "Compact imminent!", fg: "#ffffff", bg: "#a01822" };
    }

    let bg = config.bg;
    if (remaining <= RED_TOKENS) bg = "#a01822"; // red (distinct from context-percent's #c01c28)
    else if (remaining <= AMBER_TOKENS) bg = "#b8860b"; // amber (distinct from context-percent's #a67c00)

    return { text: `~${formatTokens(remaining)} left`, fg: config.fg, bg };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/widgets.test.ts`
Expected: PASS.

- [ ] **Step 5: Type check and commit**

```bash
npm run typecheck
npm run build
git add src/widgets/compact-countdown.ts src/__tests__/widgets.test.ts
git add -f dist/index.js
git commit -m "Predict auto-compact from the token reserve, not a fixed fraction (#37)"
```

---

### Task 4: `context-percent` colours from the same point

**Files:**
- Modify: `src/widgets/context-percent.ts`
- Test: `src/__tests__/widgets.test.ts` (existing `contextPercentWidget` describe block)

**Interfaces:**
- Consumes: `tokensUntilCompact`, `AMBER_TOKENS`, `RED_TOKENS` from Task 1; `ContextUsage.usedTokens` from Task 2.
- Produces: no new exports. Bar, percentage text and size suffix are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the `contextPercentWidget` describe block in `src/__tests__/widgets.test.ts`:

```ts
  it("turns amber at Claude Code's warn level, not at 70%", () => {
    // 147k of 200k used leaves 20k before compaction.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 73.5, context_window_size: 200_000 } },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#a67c00");
  });

  it("turns red 5k before compaction, so the red state is reachable", () => {
    // The old 90% danger threshold sat above the 83.5% compaction point at a
    // 200k window, so a session compacted before it could ever turn red.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 81, context_window_size: 200_000 } },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#c01c28");
  });

  it("keeps the configured background at 70% of a 200k window", () => {
    // 140k used leaves 27k — outside both bands under the derived rule.
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 70, context_window_size: 200_000 } },
    });
    const result = contextPercentWidget.render(ctx, {
      type: "context-percent",
      bg: "#0d7377",
    });
    expect(result!.bg).toBe("#0d7377");
  });

  it("scales the bands to a 1M window", () => {
    const amber = contextPercentWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 94.7, context_window_size: 1_000_000 } },
      }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(amber!.bg).toBe("#a67c00");

    // 90% of a 1M window is 900k used — 67k of headroom left, no alert.
    const calm = contextPercentWidget.render(
      makeContext({
        stdin: { context_window: { used_percentage: 90, context_window_size: 1_000_000 } },
      }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(calm!.bg).toBe("#0d7377");
  });

  it("falls back to percentage thresholds when no window size is reported", () => {
    const warn = contextPercentWidget.render(
      makeContext({ stdin: { context_window: { used_percentage: 75 } } }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(warn!.bg).toBe("#a67c00");

    const danger = contextPercentWidget.render(
      makeContext({ stdin: { context_window: { used_percentage: 95 } } }),
      { type: "context-percent", bg: "#0d7377" },
    );
    expect(danger!.bg).toBe("#c01c28");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/widgets.test.ts`
Expected: FAIL — at 73.5% the widget still returns the configured bg (its warn threshold is 70%, which it passes, so check the specific failures: the "keeps the configured background at 70%" and 1M cases fail first).

- [ ] **Step 3: Write the implementation**

In `src/widgets/context-percent.ts`, add the imports:

```ts
import type { ContextUsage } from "../utils/context-usage.js";
import { deriveContextUsage } from "../utils/context-usage.js";
import { tokensUntilCompact, AMBER_TOKENS, RED_TOKENS } from "../utils/autocompact.js";
```

(The existing `deriveContextUsage` import line is replaced by the two lines above.)

Replace `thresholdBg` with:

```ts
/**
 * Alert colour.
 *
 * Measured against the auto-compact point rather than raw fullness, so this
 * segment and compact-countdown change on the same turn at any window size.
 * The percentage thresholds remain for payloads that report no window size.
 */
function thresholdBg(usage: ContextUsage, configBg?: string): string | undefined {
  const remaining =
    usage.usedTokens !== null && usage.windowSize !== null
      ? tokensUntilCompact(usage.usedTokens, usage.windowSize)
      : null;

  if (remaining !== null) {
    if (remaining <= RED_TOKENS) return "#c01c28"; // red
    if (remaining <= AMBER_TOKENS) return "#a67c00"; // yellow
    return configBg;
  }

  if (usage.ratio >= THRESHOLD_DANGER) return "#c01c28"; // red
  if (usage.ratio >= THRESHOLD_WARN) return "#a67c00"; // yellow
  return configBg;
}
```

Update the single call site in `render` from `thresholdBg(usage.ratio, config.bg)` to `thresholdBg(usage, config.bg)`. Leave `THRESHOLD_WARN`, `THRESHOLD_DANGER`, `BAR_WIDTH` and `buildBar` as they are — the constants are still used by the fallback path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/widgets.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If `src/__tests__/defaults.test.ts` or `src/__tests__/statusline.test.ts` fails, read the failure — it means a fixture crossed a band boundary and its expectation needs the same treatment as Task 3's.

- [ ] **Step 6: Type check and commit**

```bash
npm run typecheck
npm run build
git add src/widgets/context-percent.ts src/__tests__/widgets.test.ts
git add -f dist/index.js
git commit -m "Colour context-percent from the auto-compact point (#37)"
```

---

### Task 5: Render-level adjacency guard

**Files:**
- Modify: `src/__tests__/renderer.test.ts`

**Interfaces:**
- Consumes: `renderStatusline` and `DEFAULT_SETTINGS`; the widget behaviour from Tasks 3 and 4.
- Produces: no exports.

Why this test and not a config check: both widgets pick `bg` at render time from thresholds, so a test that reads configured colours passes while the shipped bar merges. This design now makes the two segments enter their alert bands on the *same turn by construction*, so the collision is guaranteed rather than incidental. `src/__tests__/color-compare.test.ts` already records the two pairs as ΔE 4.61 (amber) and ΔE 6.54 (red) — both below `MIN_SEPARATOR_DELTA` (8) — so the thin separator is what keeps them readable. This test proves it actually gets drawn end to end.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/renderer.test.ts`. Add `DEFAULT_SETTINGS` to the imports at the top of the file:

```ts
import { DEFAULT_SETTINGS } from "../config/defaults.js";
```

Then append this describe block at the end of the file:

```ts
describe("default bar adjacency across the alert bands", () => {
  // context-percent and compact-countdown sit next to each other on line 1 and
  // now enter their bands on the same turn by construction. Their alert shades
  // are ΔE 4.61 (amber) and 6.54 (red) apart — both under MIN_SEPARATOR_DELTA —
  // so the wide glyph would be invisible and the thin one must be drawn.
  // Assert on rendered output: a config-level check cannot see this, because
  // both widgets override bg at render time. See issues #36, #40.
  function renderDefaultBar(usedPercentage: number, windowSize: number): string {
    const context = makeContext({
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        context_window: {
          used_percentage: usedPercentage,
          context_window_size: windowSize,
        },
      },
      terminalWidth: 400,
    });
    const settings = makeSettings({
      lines: DEFAULT_SETTINGS.lines,
      powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
    });
    return stripAnsi(renderStatusline(context, settings)).split("\n")[0]!;
  }

  // context-percent's text ends with the window-size suffix ")", and
  // compact-countdown's begins with "~" or "Compact". Matching that specific
  // junction keeps the assertion about these two segments — a whole-line
  // search for the glyph would also see every other pair on the bar.
  function separatorBetweenAlertSegments(line: string): string | undefined {
    return /\)\s*(│|▶)\s*(?:~|Compact)/.exec(line)?.[1];
  }

  it.each([
    ["amber band, 200k", 73.5, 200_000],
    ["red band, 200k", 81, 200_000],
    ["compact imminent, 200k", 83.5, 200_000],
    ["amber band, 1M", 94.7, 1_000_000],
    ["red band, 1M", 96.2, 1_000_000],
  ])("draws a thin separator between the two alert segments (%s)", (_label, pct, size) => {
    const line = renderDefaultBar(pct, size);
    expect(separatorBetweenAlertSegments(line)).toBe("│");
  });

  it("uses the wide separator when neither segment is alerting", () => {
    const line = renderDefaultBar(25, 200_000);
    expect(separatorBetweenAlertSegments(line)).toBe("▶");
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes for the right reason**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: PASS. This is a characterisation test over behaviour built in Tasks 3–4, so passing immediately is the correct outcome.

To confirm it is a real guard rather than a vacuous one, temporarily change `MIN_SEPARATOR_DELTA` in `src/render/powerline.ts` from `8` to `0`, re-run, and check the five band cases now FAIL. **Revert that edit before continuing.**

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/renderer.test.ts
git commit -m "Guard the alert-band adjacency at render level (#37)"
```

No `npm run build` here — this task touches only a test file, so the bundle is unchanged.

---

### Task 6: Documentation and issue closure

**Files:**
- Modify: `README.md:167` and `README.md:186-196`

**Interfaces:**
- Consumes: the constants from Task 1.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the widget table link**

Replace line 167 of `README.md`:

```markdown
| `compact-countdown` | Tokens remaining before auto-compact ([see note](#about-the-auto-compact-countdown)) |
```

- [ ] **Step 2: Replace the estimate section**

Replace the whole `### About the auto-compact estimate` section (lines 186–196) with:

```markdown
### About the auto-compact countdown

`compact-countdown` and `context-percent` both predict the same event: Claude
Code's auto-compact. It fires once the context reaches **`window size − 33,000`
tokens** — a fixed reserve (20,000 tokens of output headroom plus a 13,000-token
compaction reserve), not a percentage of the window.

| Window | Compacts at | As a percentage |
|--------|------------:|----------------:|
| 200k | 167,000 | 83.5% |
| 1M | 967,000 | 96.7% |

Both widgets turn amber 20,000 tokens before that point — Claude Code's own
internal warning level — and red 5,000 tokens before it, so the two segments
change together.

The rule is derived from Claude Code 2.1.220 rather than reported by it, so it
can drift when Claude Code changes. Two Claude Code settings also change the
answer and are invisible to a statusline command, so the prediction will be
wrong if you use them:

- `autoCompactWindow` (or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment
  variable) shrinks the window, so compaction fires earlier than shown.
- `autoCompactEnabled: false` disables compaction entirely, so it never fires.
```

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -rn "16.5\|83.5%" README.md src/`
Expected: only the `83.5%` inside the new README table and any test comments explaining the old constant. No live code references `16.5`.

- [ ] **Step 4: Run the full suite one final time**

Run: `npm test && npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document the derived auto-compact rule (#37)"
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "Derive the auto-compact threshold instead of estimating it (#37)" --body "$(cat <<'EOF'
Closes #37.

`compact-countdown` assumed auto-compact fires at 83.5% of the context window —
an unverified estimate. Extracted from the shipped Claude Code 2.1.220 binary,
the real rule is a fixed token reserve:

    effectiveWindow = window - min(maxOutputTokens, 20_000)
    threshold       = effectiveWindow - 13_000

Default `max_output_tokens` is 32,000, so the reserve is always 33,000 tokens.

| Window | True threshold | Old assumption | Error |
|--------|---------------:|---------------:|------:|
| 200k | 167,000 (83.5%) | 167,000 | exact |
| 1M | 967,000 (96.7%) | 835,000 | 132k early |

The old constant was exact at 200k and 132k tokens early at 1M, which is why it
survived review. The same binary corroborates the rule with a hardcoded
precompute default of `967000` for a 1M window.

Also:

- `context-percent`'s red moves off 90% — above the 200k compaction point, so it
  was unreachable — and onto the same two band boundaries, so the adjacent
  segments now tell one story.
- `deriveContextUsage` exposes exact `usedTokens`; `used_percentage` is a whole
  number, which at a 1M window quantises to 10k steps against a 33k budget.
- Render-level guard for the alert-band adjacency the change makes deterministic.
- `autoCompactWindow` and `autoCompactEnabled` are documented as known
  limitations — neither is visible in the statusline payload.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification checklist

Before declaring the work done, confirm each with actual command output:

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `git status` shows `dist/index.js` committed alongside every `src/` change
- [ ] `grep -rn "AUTOCOMPACT_THRESHOLD\|HEADROOM_WARN\|HEADROOM_DANGER" src/` returns nothing
- [ ] The `MIN_SEPARATOR_DELTA = 0` sabotage from Task 5 Step 2 was reverted
