# Token Accounting Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop gccusage displaying two numbers that are wrong rather than absent — token sums inflated ~2.12× by counting content-block lines as separate turns (#52), and a burn rate that divides a context-window snapshot by session duration (#53).

**Architecture:** Two independent changes in `src/`. The parser gains a `message.id` dedup gate ported from the merged `scripts/lib/parse.ts`. The `BurnRate` type loses its token field, both producers stop computing a token sum, and the widget renders the already-correct cost rate instead.

**Tech Stack:** TypeScript, tsdown bundler, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-token-accounting-design.md`

## Global Constraints

- **Every commit touching `src/` must rebuild and stage the bundle.** Run `npm run build` and `git add -f dist/index.js` in the same commit. `dist/` is gitignored but force-tracked, and `gccusage setup` points `statusLine.command` at it — a `src/`-only commit leaves `git pull` upgraders running the old code. This has shipped a bug before (PR #38).
- **No new dependencies.** Nothing added to `dependencies` or `devDependencies`.
- **`src/` uses `.js` import specifiers** (`from "../utils/format.js"`) — tsdown rewrites them at build time. This is the opposite of the convention in `scripts/`, which runs raw under Node and uses `.ts`. Do not "fix" either to match the other.
- **Type-only imports use `import type`** — `verbatimModuleSyntax` is on.
- Existing tests live in `src/__tests__/` and use `import { describe, it, expect } from "vitest";`.
- Branch `fix/token-accounting-52-53` is already checked out. Do not create a branch.
- The two tasks are independent: neither depends on the other's changes. They are ordered by severity, not by coupling.

---

### Task 1: Dedup the JSONL reader on `message.id` (#52)

**Files:**
- Modify: `src/data/jsonl-reader.ts:28-41` (`parseJsonlContent`)
- Test: `src/__tests__/jsonl-reader.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no signature change. `parseJsonlContent(content: string): JsonlEntry[]` keeps its shape; only which lines it emits changes. `normalizeEntry` and the `JsonlEntry` interface are untouched.

**Why this is the fix.** Claude Code writes one JSONL line per content block — a response with `thinking`, `text` and two `tool_use` blocks is four `type: "assistant"` lines — and **every one carries a byte-identical copy of the same `message.usage`**. Measured on the local corpus: 21,929 usage-bearing lines against 10,368 distinct `message.id` groups, and in 6,156 of 6,156 multi-line groups the usage objects agree exactly.

**The gate is deliberately narrow.** Skip a line only when it has a `message.id`, carries usage, and that id has been seen. Records without a `message.id` stay separate — the legacy flat transcript format has no `message` wrapper and was never split across lines, so deduping it would be wrong. Lines carrying no usage are left alone so nothing reading `costUsd`, `timestamp` or `sessionId` changes behaviour.

- [ ] **Step 1: Write the failing tests**

Add these to the existing `describe("parseJsonlContent", ...)` block in `src/__tests__/jsonl-reader.test.ts`:

```typescript
  it("counts one entry per message.id, not per content-block line", () => {
    // Claude Code splits one API response across a line per content block,
    // repeating an identical usage object on each. Counting lines double-counts
    // tokens, and does it non-uniformly: responses with more blocks weigh more.
    const usage = '"usage":{"input_tokens":2,"output_tokens":296,"cache_read_input_tokens":20233}';
    const content = [
      `{"type":"assistant","message":{"id":"msg_01","model":"claude-opus-4-6",${usage},"content":[{"type":"thinking"}]}}`,
      `{"type":"assistant","message":{"id":"msg_01","model":"claude-opus-4-6",${usage},"content":[{"type":"text"}]}}`,
      `{"type":"assistant","message":{"id":"msg_01","model":"claude-opus-4-6",${usage},"content":[{"type":"tool_use"}]}}`,
    ].join("\n");

    const entries = parseJsonlContent(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.usage?.output_tokens).toBe(296);
  });

  it("keeps distinct message ids as separate entries", () => {
    const usage = '"usage":{"input_tokens":10,"output_tokens":20}';
    const content = [
      `{"type":"assistant","message":{"id":"msg_01",${usage}}}`,
      `{"type":"assistant","message":{"id":"msg_02",${usage}}}`,
    ].join("\n");

    expect(parseJsonlContent(content)).toHaveLength(2);
  });

  it("keeps usage-bearing entries that carry no message id", () => {
    // The legacy flat format has no `message` wrapper and was never split
    // across lines, so it must not be collapsed.
    const content = [
      '{"type":"response","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100}}',
      '{"type":"response","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100}}',
    ].join("\n");

    expect(parseJsonlContent(content)).toHaveLength(2);
  });

  it("leaves lines that carry no usage alone", () => {
    // Only token sums are at risk from duplication. A repeated id on a
    // usage-free line must not suppress costUsd or timestamp data.
    const content = [
      '{"type":"assistant","message":{"id":"msg_01"},"costUsd":0.25}',
      '{"type":"assistant","message":{"id":"msg_01"},"costUsd":0.25}',
    ].join("\n");

    expect(parseJsonlContent(content)).toHaveLength(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/jsonl-reader.test.ts`
Expected: the first test FAILS with `expected length 1, received 3`. The other three PASS already — they pin behaviour that must survive the change, which is the point of writing them now.

- [ ] **Step 3: Implement the dedup**

Replace `parseJsonlContent` in `src/data/jsonl-reader.ts` with:

```typescript
/**
 * Parse a transcript's lines into entries, one per API response.
 *
 * Claude Code writes one line per content block — a response with a
 * `thinking` block, a `text` block and two `tool_use` blocks is four
 * `type: "assistant"` lines — and repeats a byte-identical `message.usage`
 * on every one of them. Counting lines therefore over-counts tokens by
 * roughly 2.1x on a real corpus, and does so non-uniformly: responses with
 * more content blocks weigh more, so it is not a constant factor that
 * cancels out downstream.
 *
 * The gate is narrow on purpose. A line is dropped only when it has a
 * `message.id`, carries usage, and that id has been seen. Entries without a
 * `message.id` stay separate: the legacy flat format has no `message`
 * wrapper and was never split across lines. Entries without usage stay too,
 * so nothing reading `costUsd`, `timestamp` or `sessionId` is affected.
 */
export function parseJsonlContent(content: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  const seenMessageIds = new Set<string>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const entry = normalizeEntry(parsed);

      if (entry.usage) {
        const message =
          typeof parsed["message"] === "object" && parsed["message"] !== null
            ? (parsed["message"] as Record<string, unknown>)
            : undefined;
        const messageId = typeof message?.["id"] === "string" ? message["id"] : null;

        if (messageId !== null) {
          if (seenMessageIds.has(messageId)) continue;
          seenMessageIds.add(messageId);
        }
      }

      entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/jsonl-reader.test.ts`
Expected: PASS, including the four new tests and every pre-existing one.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all pass. If a cost or aggregation test now fails with a roughly-halved number, that is this fix working — but **do not adjust the expectation without reading the fixture first.** Confirm the fixture actually contains repeated `message.id` values before changing any number, and say so in your report.

- [ ] **Step 6: Measure the real-world effect**

Run:
```bash
node -e '
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=path.join(os.homedir(),".claude","projects");
let lines=0,ids=new Set();
for(const p of fs.readdirSync(dir)){
  const d=path.join(dir,p);
  if(!fs.statSync(d).isDirectory())continue;
  for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".jsonl"))){
    for(const l of fs.readFileSync(path.join(d,f),"utf8").split("\n")){
      if(!l.trim())continue;
      try{const j=JSON.parse(l);
        if(j.type!=="assistant"||!j.message?.usage)continue;
        lines++; if(j.message.id)ids.add(f+j.message.id);
      }catch{}
    }
  }
}
console.log("usage-bearing lines:",lines,"distinct ids:",ids.size,"ratio:",(lines/ids.size).toFixed(2));
'
```
Expected: a ratio near 2.1. Record the actual numbers in your report — they are the evidence that the fix targets a real effect rather than a hypothetical one.

- [ ] **Step 7: Build and commit**

The bundle must ship with the source change:

```bash
npm run build
git add src/data/jsonl-reader.ts src/__tests__/jsonl-reader.test.ts
git add -f dist/index.js
git commit -m "Count one JSONL entry per message.id, not per content block (#52)

Claude Code writes one line per content block and repeats an identical
message.usage on each, so summing per line inflated token totals ~2.1x —
non-uniformly, since responses with more blocks weigh more. That reached
gccusage today and the calculated cost source, which pipeline.ts also
selects whenever stdin carries no cost.

The gate is narrow: a line is dropped only when it has a message.id, carries
usage, and that id was already seen. Legacy flat-format entries have no
message wrapper and are never collapsed; usage-free lines are untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Verify the bundle actually changed**

Run: `git show --stat HEAD | grep dist`
Expected: `dist/index.js` appears in the commit. If it does not, the build did not run or the force-add was skipped — fix it now with `git commit --amend`, not later.

---

### Task 2: Burn rate shows cost per hour (#53)

**Files:**
- Modify: `src/types/burn-rate.ts` (drop `tokensPerMinute`)
- Modify: `src/data/pipeline.ts:18-40` (`getStdinBurnRate`)
- Modify: `src/data/cost-calculator.ts:54-88` (`calculateBurnRate`)
- Modify: `src/widgets/burn-rate.ts`
- Modify: `src/utils/format.ts` (add `formatCostPerHour`, delete `formatTokensPerMinute`)
- Test: `src/__tests__/format.test.ts`, `src/__tests__/defaults.test.ts:109`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface BurnRate { costPerHour: number; costPerMinute: number }` — `tokensPerMinute` removed
  - `function formatCostPerHour(costPerHour: number): string`

**Two deliberate non-changes.** The widget gets **no alert thresholds** — a threshold-coloured segment creates the dynamic adjacencies a static config check cannot see (#36, #40), and there is no established danger level for a spend rate, so it keeps passing `config.fg`/`config.bg` straight through and stays `#555555` in the default layout. The **null path is unchanged**: below 10s of session, or without cost data, the producers return null and the segment disappears exactly as now.

**Why cost per hour.** Only `tokensPerMinute` is rendered today (`src/widgets/burn-rate.ts:12-13`); `costPerHour` and `costPerMinute` are computed by both producers and consumed by nothing. The rendered field is wrong on both paths — `getStdinBurnRate` divides a last-message snapshot by session duration, and `calculateBurnRate` sums genuinely cumulative metrics that #52 inflates. Meanwhile a token rate sums cache reads, so it is dominated by context size, restating what `context-percent` and `compact-countdown` already show against real thresholds. The cost rate is correct today and is the number a user can act on.

- [ ] **Step 1: Write the failing test for the formatter**

Replace the `describe("formatTokensPerMinute", ...)` block in `src/__tests__/format.test.ts` with:

```typescript
describe("formatCostPerHour", () => {
  it("formats a sub-cent rate as zero rather than a misleading fraction", () => {
    expect(formatCostPerHour(0.004)).toBe("$0.00/hr");
  });

  it("formats a rate under a dollar to cents", () => {
    expect(formatCostPerHour(0.42)).toBe("$0.42/hr");
  });

  it("formats a typical rate to cents", () => {
    expect(formatCostPerHour(4.2)).toBe("$4.20/hr");
  });

  it("drops the cents on large rates to save bar width", () => {
    expect(formatCostPerHour(120.5)).toBe("$121/hr");
  });
});
```

Also update the import at the top of the file: remove `formatTokensPerMinute` from the import list and add `formatCostPerHour`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/format.test.ts`
Expected: FAIL — `formatCostPerHour is not a function` (or a TypeScript resolution error on the import).

- [ ] **Step 3: Add the formatter and delete the dead one**

In `src/utils/format.ts`, **delete** `formatTokensPerMinute` entirely and add:

```typescript
/**
 * Spend rate for the status bar. Mirrors formatDollars' thresholds so a rate
 * and a total read consistently beside each other, and drops the cents above
 * $100/hr because bar width is scarcer than that precision is useful.
 */
export function formatCostPerHour(costPerHour: number): string {
  if (costPerHour < 0.01) return "$0.00/hr";
  if (costPerHour < 100) return `$${costPerHour.toFixed(2)}/hr`;
  return `$${costPerHour.toFixed(0)}/hr`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Narrow the BurnRate type**

Replace `src/types/burn-rate.ts` with:

```typescript
export interface BurnRate {
  costPerHour: number;
  costPerMinute: number;
}
```

- [ ] **Step 6: Run the typecheck to find every consumer**

Run: `npm run typecheck`
Expected: FAIL, with errors at each site that still reads or writes `tokensPerMinute` — `src/data/pipeline.ts`, `src/data/cost-calculator.ts`, `src/widgets/burn-rate.ts`, and `src/__tests__/defaults.test.ts`. Use this list as the worklist for the next step; the compiler is a more reliable enumerator here than grep.

- [ ] **Step 7: Stop computing the token sum in both producers**

In `src/data/pipeline.ts`, replace the body of `getStdinBurnRate` with:

```typescript
function getStdinBurnRate(stdin: StatusJson): BurnRate | null {
  const durationMs = stdin.cost?.total_duration_ms;
  if (!durationMs || durationMs < 10000) return null;

  const costUsd = stdin.cost?.total_cost_usd;
  if (costUsd === undefined) return null;

  const elapsedMinutes = durationMs / 60000;
  const costPerMinute = costUsd / elapsedMinutes;

  return { costPerHour: costPerMinute * 60, costPerMinute };
}
```

Note this drops the `context_window` lookup entirely — the snapshot fields were its only use here — and adds an explicit `costUsd === undefined` guard so a payload without cost falls through to `calculateBurnRate` rather than reporting a confident `$0.00/hr`.

In `src/data/cost-calculator.ts`, replace `calculateBurnRate` with:

```typescript
export function calculateBurnRate(
  sessionMetrics: TokenMetrics,
  sessionStartTime: number | null,
  pricing: PricingTable,
  sessionModel?: string,
): BurnRate | null {
  if (!sessionStartTime) return null;

  const elapsedMs = Date.now() - sessionStartTime;
  if (elapsedMs < 10000) return null; // need at least 10s of data

  const elapsedMinutes = elapsedMs / 60000;

  // Estimate cost rate
  let costPerMinute = 0;
  if (sessionModel) {
    const modelPricing = findPricing(sessionModel, pricing);
    if (modelPricing) {
      const sessionCost = calculateCost(sessionMetrics, modelPricing);
      costPerMinute = sessionCost / elapsedMinutes;
    }
  }

  return {
    costPerHour: costPerMinute * 60,
    costPerMinute,
  };
}
```

The signature is unchanged — `sessionMetrics` is still needed, because `calculateCost` prices it. Only the `totalTokens` sum and the `tokensPerMinute` field are gone.

- [ ] **Step 8: Render the cost rate**

Replace `src/widgets/burn-rate.ts` with:

```typescript
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { formatCostPerHour } from "../utils/format.js";

export const burnRateWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    if (!context.burnRate) return null;

    const label = config.label ?? "";
    const rate = formatCostPerHour(context.burnRate.costPerHour);
    const text = label ? `${label} ${rate}` : rate;
    return { text, fg: config.fg, bg: config.bg };
  },
};
```

- [ ] **Step 9: Fix the test fixture**

In `src/__tests__/defaults.test.ts:109`, change the `burnRate` fixture literal from
`{ tokensPerMinute: 500, costPerHour: 1, costPerMinute: 0.02 }` to
`{ costPerHour: 1, costPerMinute: 0.02 }`.

This is a fixture, not an assertion about the rate — do not change what the test asserts.

- [ ] **Step 10: Run the suite and both typechecks**

Run: `npm test && npm run typecheck && npm run typecheck:scripts`
Expected: all pass. If a widget test asserted the `tok/m` string, update it to the cost rate — that test was pinning the old display, and its intent is "the widget renders the burn rate", which still holds.

- [ ] **Step 11: Verify the built bundle renders the new segment**

Unit tests exercise the widget, not the bundle users actually run. Build and pipe a realistic payload through it:

```bash
npm run build
echo '{"session_id":"t","model":{"id":"claude-opus-4-6","display_name":"Opus"},"cost":{"total_cost_usd":2.10,"total_duration_ms":1800000},"context_window":{"context_window_size":200000,"used_percentage":30,"current_usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":100}},"workspace":{"current_dir":"'$PWD'"}}' | node dist/index.js
```
Expected: the bar renders and contains `$4.20/hr` — $2.10 over 30 minutes is $4.20/hr. It must **not** contain `tok/m`. Record the actual output in your report.

- [ ] **Step 12: Confirm nothing references the removed names**

Run: `grep -rn "tokensPerMinute\|formatTokensPerMinute" src`
Expected: no output. If anything remains, it is a consumer the typecheck missed because it was untyped — fix it before committing.

- [ ] **Step 13: Build and commit**

```bash
npm run build
git add src/types/burn-rate.ts src/data/pipeline.ts src/data/cost-calculator.ts src/widgets/burn-rate.ts src/utils/format.ts src/__tests__/format.test.ts src/__tests__/defaults.test.ts
git add -f dist/index.js
git commit -m "Show spend rate on the burn-rate segment, not a token rate (#53)

The only rendered BurnRate field was tokensPerMinute, and it was wrong on
both paths: getStdinBurnRate divided context_window.total_input_tokens — the
last assistant message's usage, not a session total — by session duration,
while the JSONL fallback summed metrics inflated by #52. Meanwhile
costPerHour and costPerMinute were computed by both producers and rendered
by nothing.

A token rate sums cache reads, so it tracks context size and restates what
context-percent and compact-countdown already show against real thresholds.
The cost rate is correct today and is the number a user can act on.

formatTokensPerMinute is deleted rather than left as a tested helper that
formats nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 14: Verify the bundle shipped**

Run: `git show --stat HEAD | grep dist`
Expected: `dist/index.js` appears in the commit. If not, `git commit --amend` it in now.

---

## Notes for the implementer

- **The bundle is the product.** Both tasks change `src/`, and both commits must carry a rebuilt `dist/index.js`. A reviewer will check this specifically.
- **Do not "fix" the import extensions.** `src/` uses `.js` because tsdown rewrites specifiers; `scripts/` uses `.ts` because it runs raw under Node. Both are correct in their own tree.
- **If a pre-existing test breaks in Task 1, read the fixture before touching the expectation.** A halved number is the fix working; a changed number for any other reason is a regression. Say which one you concluded and why.
- The two tasks are independent. If Task 2 is blocked for any reason, Task 1 still stands alone and vice versa.
