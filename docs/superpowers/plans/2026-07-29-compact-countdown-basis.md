# Compact-Countdown Fix and Statusline Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `compact-countdown`, which reports a permanent false "Compact imminent!" alarm, and put it in the default statusline in place of two low-signal segments.

**Architecture:** Extract the context-fullness derivation that `context-percent` already implements into a shared `deriveContextUsage()` helper, rewrite `compact-countdown` on top of it so the two adjacent segments agree by construction, then update `DEFAULT_SETTINGS` and the README.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, valibot, chalk, tsdown.

**Spec:** `docs/superpowers/specs/2026-07-29-statusline-defaults-compact-countdown-design.md`

**Branch:** `fix/compact-countdown-basis` (already created; spec committed as `33b836d`).

## Global Constraints

- **Import specifiers end in `.js`** even for TypeScript sources — this is an ESM project (`import { deriveContextUsage } from "../utils/context-usage.js"`).
- **Never use `context_window.total_input_tokens` or `total_output_tokens` to measure context fullness.** They are cumulative across the session and exceed the window size on any long session. They are correct only for rate math (`burn-rate` divides them by `total_duration_ms`).
- **`AUTOCOMPACT_THRESHOLD = 1 - 0.165 = 0.835`.** Carry this constant over unchanged; do not re-derive the buffer. Verified: `1 - 0.165` is exactly `0.835` in IEEE-754 double, so no float-noise guards are needed.
- **Colors are exact hex strings:** amber `#a67c00`, red `#c01c28`, blue `#1a5fb4`, green `#26a269`, teal `#0d7377`, grey `#555555`, purple `#613583`, new purple `#7d4fa8`, white `#ffffff`.
- **Run tests with `npm test`** (`vitest run`). Type-check with `npm run typecheck`.
- **Do not modify** `src/widgets/burn-rate.ts` — its use of the cumulative fields is correct.
- **`cache-hit-rate` and `api-latency` stay registered and documented.** Only their presence in `DEFAULT_SETTINGS` is removed, so users can restore them via config.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/utils/context-usage.ts` | Create | Sole source of truth for "how full is the context window": the four-way fallback chain, returning `{ratio, windowSize}`. |
| `src/__tests__/context-usage.test.ts` | Create | Covers every fallback branch and every null path of the helper. |
| `src/widgets/context-percent.ts` | Modify | Drops its inlined derivation, consumes the helper. Rendering/threshold logic unchanged. |
| `src/widgets/compact-countdown.ts` | Modify | Rewritten onto the helper. Display and color behavior preserved. |
| `src/__tests__/widgets.test.ts` | Modify | Adds a `compactCountdownWidget` block (the widget has zero tests today). |
| `src/config/defaults.ts` | Modify | New layout, new priorities, `git-changes` re-shade. |
| `src/__tests__/defaults.test.ts` | Create | Guards the shipped defaults: every type resolves, no adjacent shared `bg`. |
| `README.md` | Modify | Example bar at lines 6–7. |

Task 1 delivers the helper and proves the refactor is behavior-preserving. Task 2 fixes the actual defect. Task 3 ships it in the defaults. A reviewer can reject any one while accepting the others.

---

### Task 1: Shared context-usage helper

**Files:**
- Create: `src/utils/context-usage.ts`
- Create: `src/__tests__/context-usage.test.ts`
- Modify: `src/widgets/context-percent.ts:23-68` (the whole `render` body)

**Interfaces:**
- Consumes: `StatusJson` from `src/types/status-json.ts`.
- Produces: `deriveContextUsage(stdin: StatusJson): ContextUsage | null` and `interface ContextUsage { ratio: number; windowSize: number | null }`. Task 2 depends on both names exactly as written.

**Why `windowSize` is nullable:** `context-percent` renders today when `used_percentage` is present but `context_window_size` is absent — it just omits the ` (200.0k)` suffix. Making `windowSize` non-null would turn that into a `null` render and break the widget.

- [ ] **Step 1: Write the failing tests for the helper**

Create `src/__tests__/context-usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveContextUsage } from "../utils/context-usage.js";

describe("deriveContextUsage", () => {
  it("prefers remaining_percentage", () => {
    const usage = deriveContextUsage({
      context_window: { remaining_percentage: 93, context_window_size: 1_000_000 },
    });
    expect(usage).toEqual({ ratio: 0.07, windowSize: 1_000_000 });
  });

  it("ignores cumulative token totals when a percentage is available", () => {
    // total_input_tokens/total_output_tokens are cumulative across the session
    // and dwarf the window; they must not influence fullness.
    const usage = deriveContextUsage({
      context_window: {
        remaining_percentage: 93,
        context_window_size: 1_000_000,
        total_input_tokens: 2_600_000,
        total_output_tokens: 90_000,
      },
    });
    expect(usage!.ratio).toBeCloseTo(0.07, 10);
  });

  it("falls back to used_percentage", () => {
    const usage = deriveContextUsage({
      context_window: { used_percentage: 25, context_window_size: 200_000 },
    });
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000 });
  });

  it("returns a null windowSize when the size is absent", () => {
    const usage = deriveContextUsage({ context_window: { used_percentage: 25 } });
    expect(usage).toEqual({ ratio: 0.25, windowSize: null });
  });

  it("falls back to summing current_usage", () => {
    const usage = deriveContextUsage({
      context_window: {
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 30_000,
          output_tokens: 5_000,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 5_000,
        },
      },
    });
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000 });
  });

  it("supports the legacy numeric context_window with token_usage", () => {
    const usage = deriveContextUsage({
      context_window: 200_000,
      token_usage: {
        input_tokens: 45_000,
        output_tokens: 5_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000 });
  });

  it("returns null when there is no context window at all", () => {
    expect(deriveContextUsage({})).toBeNull();
  });

  it("returns null when current_usage is the only basis but the size is missing", () => {
    // All four counts are required by the inferred type: CurrentUsageSchema
    // declares them with valibot defaults, so they are non-optional on output.
    const usage = deriveContextUsage({
      context_window: {
        current_usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    expect(usage).toBeNull();
  });

  it("returns null for a legacy numeric window with no token_usage", () => {
    expect(deriveContextUsage({ context_window: 200_000 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- context-usage`
Expected: FAIL — cannot resolve `../utils/context-usage.js`.

- [ ] **Step 3: Write the helper**

Create `src/utils/context-usage.ts`:

```ts
import type { StatusJson } from "../types/status-json.js";

export interface ContextUsage {
  /** Fraction of the context window consumed, 0..1. */
  ratio: number;
  /** Window size in tokens, or null when stdin did not report one. */
  windowSize: number | null;
}

interface TokenCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function sumTokens(counts: TokenCounts): number {
  return (
    (counts.input_tokens ?? 0) +
    (counts.output_tokens ?? 0) +
    (counts.cache_creation_input_tokens ?? 0) +
    (counts.cache_read_input_tokens ?? 0)
  );
}

/**
 * How full the context window is.
 *
 * Deliberately ignores `total_input_tokens` / `total_output_tokens`: those are
 * cumulative across the whole session and exceed the window size on any long
 * session. They are correct for rate math (see burn-rate), never for fullness.
 */
export function deriveContextUsage(stdin: StatusJson): ContextUsage | null {
  const cw = stdin.context_window;

  if (typeof cw === "object" && cw !== null) {
    const windowSize = cw.context_window_size ?? null;

    // remaining_percentage accounts for all tokens (input, output, system).
    if (cw.remaining_percentage != null) {
      return { ratio: (100 - cw.remaining_percentage) / 100, windowSize };
    }
    if (cw.used_percentage != null) {
      return { ratio: cw.used_percentage / 100, windowSize };
    }
    if (cw.current_usage && windowSize && windowSize > 0) {
      return { ratio: sumTokens(cw.current_usage) / windowSize, windowSize };
    }
    return null;
  }

  // Legacy format: context_window is a plain number of tokens.
  if (typeof cw === "number" && cw > 0) {
    const usage = stdin.token_usage;
    if (!usage) return null;
    return { ratio: sumTokens(usage) / cw, windowSize: cw };
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- context-usage`
Expected: PASS, 9 tests.

- [ ] **Step 5: Refactor context-percent onto the helper**

Replace the whole of `src/widgets/context-percent.ts` with:

```ts
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatPercent, formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";

const BAR_WIDTH = 10;
const THRESHOLD_WARN = 0.7;
const THRESHOLD_DANGER = 0.9;

function buildBar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "[" + "=".repeat(filled) + "-".repeat(empty) + "]";
}

function thresholdBg(ratio: number, configBg?: string): string | undefined {
  if (ratio >= THRESHOLD_DANGER) return "#c01c28"; // red
  if (ratio >= THRESHOLD_WARN) return "#a67c00"; // yellow
  return configBg; // default
}

export const contextPercentWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    if (!usage) return null;

    const label = config.label ?? "";
    const bar = buildBar(usage.ratio);
    const pct = formatPercent(usage.ratio);
    const size = usage.windowSize ? ` (${formatTokens(usage.windowSize)})` : "";
    const text = label ? `${label} ${bar} ${pct}${size}` : `${bar} ${pct}${size}`;
    return { text, fg: config.fg, bg: thresholdBg(usage.ratio, config.bg) };
  },
};
```

- [ ] **Step 6: Run the full suite to confirm the refactor changed nothing**

Run: `npm test && npm run typecheck`
Expected: PASS. The two pre-existing `contextPercentWidget` tests in `src/__tests__/widgets.test.ts` are the regression net — the legacy-numeric one asserts `"[===-------] 25% (200.0k)"`, and it must still pass untouched. If either fails, the refactor is not behavior-preserving; fix the helper rather than editing those assertions.

- [ ] **Step 7: Commit**

```bash
git add src/utils/context-usage.ts src/__tests__/context-usage.test.ts src/widgets/context-percent.ts
git commit -m "Extract shared context-usage derivation from context-percent"
```

---

### Task 2: Rewrite compact-countdown on the shared basis

**Files:**
- Modify: `src/widgets/compact-countdown.ts` (full rewrite)
- Modify: `src/__tests__/widgets.test.ts` (add import + new `describe` block)

**Interfaces:**
- Consumes: `deriveContextUsage` / `ContextUsage` from Task 1.
- Produces: no new exports. `compactCountdownWidget` keeps its existing shape and its registry entry (`"compact-countdown"`), so Task 3 needs no registry change.

**The defect being fixed:** the current implementation computes `usedTokens = total_input_tokens + total_output_tokens` — cumulative session totals — and compares them against `windowSize × 0.835`. Cumulative tokens pass that threshold within the first few turns of any session, after which the widget returns a red `Compact imminent!` forever. Step 1's first test reproduces exactly that.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/widgets.test.ts`, add to the existing import block at the top:

```ts
import { compactCountdownWidget } from "../widgets/compact-countdown.js";
```

Then append this `describe` block at the end of the file. It uses the file's existing `makeContext` helper. Every expected string below was computed against the real formatter — do not adjust them by hand:

```ts
describe("compactCountdownWidget", () => {
  it("reports real headroom on a long session with a mostly-empty context", () => {
    // Regression: total_input/output_tokens are cumulative and dwarf the window.
    // Reading them as current usage pinned this widget to "Compact imminent!".
    const ctx = makeContext({
      stdin: {
        context_window: {
          remaining_percentage: 93,
          context_window_size: 1_000_000,
          total_input_tokens: 2_600_000,
          total_output_tokens: 90_000,
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~765.0k left");
  });

  it("derives headroom from used_percentage", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 25, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~117.0k left");
  });

  it("derives headroom from current_usage", () => {
    const ctx = makeContext({
      stdin: {
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 30_000,
            output_tokens: 5_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~117.0k left");
  });

  it("supports the legacy numeric context window", () => {
    const ctx = makeContext({
      stdin: {
        context_window: 200_000,
        token_usage: {
          input_tokens: 45_000,
          output_tokens: 5_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("~117.0k left");
  });

  it("keeps the configured background when there is plenty of headroom", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 25, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.bg).toBe("#1a5fb4");
  });

  it("turns amber under 25% headroom", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 70, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~27.0k left");
    expect(result!.bg).toBe("#a67c00");
  });

  it("turns red under 10% headroom", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 80, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, {
      type: "compact-countdown",
      bg: "#1a5fb4",
    });
    expect(result!.text).toBe("~7.0k left");
    expect(result!.bg).toBe("#c01c28");
  });

  it("announces an imminent compact at the threshold", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 83.5, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("Compact imminent!");
    expect(result!.bg).toBe("#c01c28");
  });

  it("announces an imminent compact past the threshold", () => {
    const ctx = makeContext({
      stdin: { context_window: { used_percentage: 90, context_window_size: 200_000 } },
    });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result!.text).toBe("Compact imminent!");
  });

  it("returns null without a context window", () => {
    const result = compactCountdownWidget.render(makeContext(), { type: "compact-countdown" });
    expect(result).toBeNull();
  });

  it("returns null when the window size is unknown", () => {
    // A ratio alone cannot be converted into a token count.
    const ctx = makeContext({ stdin: { context_window: { used_percentage: 25 } } });
    const result = compactCountdownWidget.render(ctx, { type: "compact-countdown" });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- widgets`
Expected: FAIL. The first test is the important one — it should report `expected "Compact imminent!" to be "~765.0k left"`, which is the production defect reproduced. Several colour and null tests will also fail.

- [ ] **Step 3: Rewrite the widget**

Replace the whole of `src/widgets/compact-countdown.ts` with:

```ts
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatTokens } from "../utils/format.js";
import { deriveContextUsage } from "../utils/context-usage.js";

/** Auto-compact fires once this fraction of the context window is consumed. */
const AUTOCOMPACT_THRESHOLD = 1 - 0.165;

const HEADROOM_DANGER = 0.1;
const HEADROOM_WARN = 0.25;

export const compactCountdownWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const usage = deriveContextUsage(context.stdin);
    // Without a window size a ratio cannot be turned into a token count.
    if (!usage || !usage.windowSize) return null;

    const threshold = usage.windowSize * AUTOCOMPACT_THRESHOLD;
    const remaining = Math.max(0, Math.round(threshold - usage.ratio * usage.windowSize));

    if (remaining <= 0) {
      return { text: "Compact imminent!", fg: "#ffffff", bg: "#c01c28" };
    }

    const headroom = remaining / threshold;
    let bg = config.bg;
    if (headroom < HEADROOM_DANGER) bg = "#c01c28"; // red
    else if (headroom < HEADROOM_WARN) bg = "#a67c00"; // amber

    return { text: `~${formatTokens(remaining)} left`, fg: config.fg, bg };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including the 11 new `compactCountdownWidget` tests.

- [ ] **Step 5: Commit**

```bash
git add src/widgets/compact-countdown.ts src/__tests__/widgets.test.ts
git commit -m "Fix compact-countdown measuring cumulative tokens as context usage"
```

---

### Task 3: Update the shipped defaults and README

**Files:**
- Modify: `src/config/defaults.ts:5-27` (both `lines` entries)
- Create: `src/__tests__/defaults.test.ts`
- Modify: `README.md:6-7`

**Interfaces:**
- Consumes: `compactCountdownWidget` behavior from Task 2; `getWidget` from `src/widgets/registry.ts`.
- Produces: no new exports.

**Two mechanics that drive this task:**
1. `priority` is *keep-first*, not drop-first. `renderCompact` sorts ascending and greedily fits until the terminal width is exhausted. `compact-countdown` therefore takes priority 4 — headroom matters most when space is tight.
2. `renderPowerlineSegments` draws each separator in `prevBg` over the incoming `bg`. When adjacent segments share a `bg` the `▶` is invisible. `git-branch` and `git-changes` are both `#613583` today, so line 2 renders as one merged purple block; `git-changes` moves to `#7d4fa8`.

- [ ] **Step 1: Write the failing guard tests**

Create `src/__tests__/defaults.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- defaults`
Expected: FAIL on two of the four — the adjacency test (`git-branch and git-changes share a background`) and the compact-countdown test (`expected undefined to be defined`). The registered-types and distinct-priorities tests should already pass.

- [ ] **Step 3: Update the default layout**

In `src/config/defaults.ts`, replace both `lines` entries (leave `powerline`, `compact`, `alerts`, `cache`, and `costSource` untouched):

```ts
  lines: [
    {
      widgets: [
        { type: "model", fg: "#ffffff", bg: "#1a5fb4", priority: 1 },
        { type: "session-cost", fg: "#ffffff", bg: "#26a269", priority: 2 },
        { type: "context-percent", fg: "#ffffff", bg: "#0d7377", priority: 3 },
        { type: "compact-countdown", fg: "#ffffff", bg: "#1a5fb4", priority: 4 },
        { type: "burn-rate", fg: "#ffffff", bg: "#555555", priority: 7 },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "git-branch", fg: "#ffffff", bg: "#613583", priority: 5 },
        { type: "git-changes", fg: "#ffffff", bg: "#7d4fa8", priority: 8 },
        { type: "lines-changed", fg: "#ffffff", bg: "#0d7377", priority: 9 },
        { type: "today-spend", fg: "#ffffff", bg: "#26a269", priority: 6 },
        { type: "vim-mode" },
      ],
      flex: "left",
    },
  ],
```

Removed: `cache-hit-rate` (line 1) and `api-latency` (line 2). Both remain in the registry and the README table.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, all four `DEFAULT_SETTINGS` tests included.

- [ ] **Step 5: Update the README example**

In `README.md`, replace lines 6–7:

```
 Opus 4.6 ▶ $14.21 ▶ [========--] 82% (200.0k) ▶ 11.6k tok/m ▶ Cache: 99% ▶
 main ▶ +307 -43 ▶ Today: $14.50 ▶ API: 9m 55s ▶
```

with:

```
 Opus 4.6 ▶ $14.21 ▶ [========--] 82% (200.0k) ▶ ~3.0k left ▶ 11.6k tok/m ▶
 main ▶ +2 ~5 -1 ▶ +307 -43 ▶ Today: $14.50 ▶
```

Two details that make this example honest rather than plausible-looking:

- `~3.0k left` is the real figure for the 82%-of-200k session shown:
  `200000 × (0.835 − 0.82) = 3000`. At that headroom the segment renders red,
  which is the point of showing it.
- The segments are `git-changes` then `lines-changed`, and they are *not* the
  same units. `git-changes` counts files (`+2 ~5 -1` — added, modified,
  deleted); `lines-changed` counts lines (`+307 -43`). The `+307 -43` in the
  current README is `lines-changed`; `git-changes` was absent from the old
  example because it returns `null` on a clean tree.

Leave the widget reference table alone — it already lists all 25 widgets including `compact-countdown`, `cache-hit-rate`, and `api-latency`.

- [ ] **Step 6: Verify the rendered output end to end**

```bash
npm run build
rm -f ~/.cache/gccusage/statusline-cache.json
echo '{"session_id":"plan-check","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":14.21},"context_window":{"used_percentage":82,"context_window_size":200000}}' | node dist/index.js
```

Expected: two lines; line 1 ends with a red `~3.0k left` segment followed by the burn-rate segment (burn-rate may be absent without duration data — that is fine); no `Cache:` or `API:` segment anywhere. Confirm the `▶` between `main` and the git-changes segment is now visible.

Clear the cache again afterwards so your own statusline picks up the new build: `rm -f ~/.cache/gccusage/statusline-cache.json`.

- [ ] **Step 7: Commit**

```bash
git add src/config/defaults.ts src/__tests__/defaults.test.ts README.md
git commit -m "Surface compact-countdown in default layout, retire two low-signal segments"
```

---

## Done When

- `npm test` and `npm run typecheck` both pass.
- `compact-countdown` reports real headroom on a long session instead of a permanent `Compact imminent!`.
- The default statusline shows the countdown and no longer shows `Cache:` or `API:`.
- The separator between `main` and the git-changes segment is visible.
- Three commits on `fix/compact-countdown-basis`, on top of the spec commit `33b836d`.

## Out of Scope

Do not do these as part of this plan:

- The other seven unwired widgets (`session-timer`, `token-breakdown`, `turn-counter`, `block-timer`, `cwd`, `per-model`, `session-clock`).
- New widgets for stdin fields `StatusJsonSchema` does not parse (`output_style.name`, `agent.name`, `exceeds_200k_tokens`, `workspace.project_dir`, `transcript_path`).
- `powerline.separatorThin`, which is in the defaults but never read by `renderPowerlineSegments`.
- Re-deriving whether 16.5% is still the correct auto-compact buffer, or whether it differs for 1M-context sessions.
