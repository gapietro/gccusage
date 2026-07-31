# Token-Efficiency Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a committed, re-runnable transcript-analysis script and use its output to write a findings document that decides what a token-efficiency meter should measure (issue #49).

**Architecture:** A thin CLI entry point (`scripts/analyze-transcripts.ts`) over five focused library modules — corpus discovery, transcript parsing, statistics, analysis, and report rendering. Each module is pure enough to unit-test against small in-memory fixtures. The script reads `~/.claude/projects/`, emits anonymised aggregates as JSON or Markdown, and the findings document is written from that output.

**Tech Stack:** TypeScript run natively by Node (no transpiler, no new dependencies), vitest for tests, existing repo conventions.

**Spec:** `docs/superpowers/specs/2026-07-31-token-efficiency-research-design.md`

## Global Constraints

- **No new dependencies.** Node ≥23.6 strips TypeScript types natively; the script runs as `node scripts/analyze-transcripts.ts`. The repo's `engines` field says `node >=18` and `npm run dev` invokes `bun`, which is **not installed on this machine** — do not use bun in any step.
- **Nothing under `src/`.** This plan touches `scripts/`, `docs/`, `package.json`, and `tsconfig.scripts.json` only. Because no `src/` file changes, **no `npm run build` and no `git add -f dist/index.js` is required.** If a task ever needs a `src/` change, stop and flag it — the rebuild rule applies again.
- **Anonymised output only.** Project directory names map to stable `proj-a`, `proj-b`, … labels. Numeric aggregates and tool names may be emitted. Prompt text, file contents, file paths, and directory names must never reach stdout or the findings doc.
- **Imports use the `.js` extension** on relative paths (`from "./stats.js"`), matching the existing `src/` code under `"moduleResolution": "bundler"` + `"verbatimModuleSyntax": true`.
- **Type-only imports use `import type`** — `verbatimModuleSyntax` is on, so a value import of a type is a compile error.
- Branch is already created: `research/token-efficiency-49`. Commit after every task.
- Percentiles in the script use **linear interpolation**; the scoping probes in the spec used floor-index selection. Small differences from the spec's preliminary readings (e.g. p50 97.5% vs 97.4%) are expected and are **not** a discrepancy. A difference of more than ~1 percentage point is.

---

### Task 1: Statistics helpers and script scaffolding

**Files:**
- Create: `tsconfig.scripts.json`
- Create: `scripts/lib/stats.ts`
- Modify: `package.json` (add `analyze` and `typecheck:scripts` npm scripts)
- Test: `scripts/__tests__/stats.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface Summary { n: number; min: number; p10: number; p25: number; p50: number; p75: number; p90: number; p99: number; max: number; mean: number }`
  - `function percentile(values: number[], p: number): number` — `p` in `[0, 1]`, linear interpolation, returns `NaN` for an empty array
  - `function summarize(values: number[]): Summary`
  - `const COST_WEIGHTS: { input: 1; output: 5; cacheWrite: 1.25; cacheRead: 0.1 }`
  - `function costEquivalent(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number`

Note: `costEquivalent` takes a structural parameter type rather than importing `TurnUsage` from `parse.ts`, so `stats.ts` has no imports and Task 2 can depend on it without a cycle.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/stats.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { percentile, summarize, costEquivalent, COST_WEIGHTS } from "../lib/stats.js";

describe("percentile", () => {
  it("returns NaN for an empty array", () => {
    expect(percentile([], 0.5)).toBeNaN();
  });

  it("returns the only value for a single-element array", () => {
    expect(percentile([42], 0.9)).toBe(42);
  });

  it("returns the median of an odd-length array", () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
  });

  it("interpolates between neighbours", () => {
    // p75 over [0,1,2,3]: index 0.75*3 = 2.25 -> 2 + (3-2)*0.25
    expect(percentile([0, 1, 2, 3], 0.75)).toBeCloseTo(2.25, 10);
  });

  it("does not mutate the caller's array", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it("returns the extremes at p=0 and p=1", () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });
});

describe("summarize", () => {
  it("reports n, min, max and mean", () => {
    const s = summarize([1, 2, 3, 4]);
    expect(s.n).toBe(4);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.mean).toBe(2.5);
  });

  it("reports a zero-length summary without throwing", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.p50).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});

describe("costEquivalent", () => {
  it("weights a pure fresh-input turn at 1x per token", () => {
    expect(
      costEquivalent({
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(100);
  });

  it("weights output at 5x and cache reads at 0.1x", () => {
    expect(
      costEquivalent({
        inputTokens: 0,
        outputTokens: 10,
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
      }),
    ).toBeCloseTo(50 + 100, 10);
  });

  it("weights cache creation at 1.25x", () => {
    expect(
      costEquivalent({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 400,
      }),
    ).toBe(500);
  });
});

describe("COST_WEIGHTS", () => {
  it("keeps the documented ratios", () => {
    expect(COST_WEIGHTS).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/__tests__/stats.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/stats.js"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/stats.ts`:

```typescript
export interface Summary {
  n: number;
  min: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * Linear-interpolation percentile. `p` is a fraction in [0, 1].
 * Returns NaN for an empty input rather than throwing, so callers can
 * summarise an empty slice (e.g. a tool nobody called) without branching.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function summarize(values: number[]): Summary {
  const n = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    n,
    min: n === 0 ? Number.NaN : Math.min(...values),
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99),
    max: n === 0 ? Number.NaN : Math.max(...values),
    mean: n === 0 ? Number.NaN : sum / n,
  };
}

/**
 * Per-token cost relative to one uncached input token.
 *
 * Output is 5x input across the entire current Claude lineup (Opus 5
 * $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50), cache
 * writes are 1.25x at the default 5-minute TTL, and cache reads are 0.1x.
 *
 * Ratios rather than dollar prices, deliberately: the result is
 * model-independent and does not go stale when list prices change. The
 * unit is "input-token-equivalents", not dollars.
 */
export const COST_WEIGHTS = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;

export function costEquivalent(u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    u.inputTokens * COST_WEIGHTS.input +
    u.outputTokens * COST_WEIGHTS.output +
    u.cacheCreationTokens * COST_WEIGHTS.cacheWrite +
    u.cacheReadTokens * COST_WEIGHTS.cacheRead
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/__tests__/stats.test.ts`
Expected: PASS, 12 tests.

Note: `summarize` uses `Math.min(...values)` / `Math.max(...values)`. Spread on an array of ~90 session values is fine. It is **not** used on per-turn arrays of 20k+ elements anywhere in this plan; if a later task needs that, replace with a reduce.

- [ ] **Step 5: Add the scripts tsconfig**

The root `tsconfig.json` has `"rootDir": "src"` and `"include": ["src"]`, so `npm run typecheck` does not see `scripts/`. Add a sibling config rather than widening the root one.

Create `tsconfig.scripts.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["scripts"]
}
```

- [ ] **Step 6: Add the npm scripts**

In `package.json`, inside `"scripts"`, add these two entries after `"typecheck"`:

```json
    "typecheck": "tsc --noEmit",
    "typecheck:scripts": "tsc -p tsconfig.scripts.json",
    "analyze": "node scripts/analyze-transcripts.ts"
```

(`"typecheck"` is shown for placement only — do not duplicate it.)

- [ ] **Step 7: Verify typecheck passes**

Run: `npm run typecheck:scripts`
Expected: exits 0 with no output. If it reports "No inputs were found", the `include` glob is wrong — `scripts/lib/stats.ts` must exist first.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all existing tests plus the 12 new ones pass, **and `scripts/__tests__/stats.test.ts` appears among the collected files.**

`vitest.config.ts` pins `include` to `src/**/__tests__/**/*.test.ts`, so a `scripts/` test passes when named directly but is invisible to `npm test`. Add the second glob:

```typescript
    include: ["src/**/__tests__/**/*.test.ts", "scripts/**/__tests__/**/*.test.ts"],
```

Commit that change separately, with its own message — it is a repo-wide test-discovery fix, not part of the statistics helpers. Leave the `coverage` block alone: the research script is dev tooling and does not belong in the shipped coverage numbers.

(An earlier draft of this plan asserted no vitest config existed. It does; the check that produced that claim aborted on a shell glob no-match before listing it. Every later task in this plan depends on `scripts/` tests being collected.)

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/stats.ts scripts/__tests__/stats.test.ts tsconfig.scripts.json package.json
git commit -m "Add statistics helpers for transcript analysis (#49)

Percentiles, distribution summaries, and the cost-weight model the
decomposition stage needs. Cost is expressed in input-token-equivalents
using published ratios (output 5x, cache write 1.25x, cache read 0.1x)
rather than dollar prices, so the figures stay model-independent and do
not go stale when list prices change.

Adds tsconfig.scripts.json because the root config pins rootDir to src/,
so npm run typecheck would not otherwise see scripts/.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Transcript parser

**Files:**
- Create: `scripts/lib/parse.ts`
- Test: `scripts/__tests__/parse.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (structural typing only).
- Produces:
  - `interface TurnUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }`
  - `interface Turn { usage: TurnUsage; toolNames: string[] }`
  - `interface ToolResultRecord { toolName: string | null; bytes: number }`
  - `interface SessionRecord { sessionId: string; turns: Turn[]; toolResults: ToolResultRecord[]; userPrompts: number; compactBoundaries: number }`
  - `function parseTranscript(lines: Iterable<string>, sessionId: string): SessionRecord`
  - `function readTranscript(filePath: string, sessionId: string): SessionRecord`

**Transcript shape (established by inspection on 2026-07-31):**

- Assistant turns: `{"type":"assistant","message":{"usage":{...},"content":[...]}}`. `usage` carries `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. `content` may contain `{"type":"tool_use","id":"toolu_...","name":"Bash"}` blocks.
- Tool results: `{"type":"user","toolUseResult":<any>,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_..."}]}}`. The tool *name* is not on this record — it must be looked up from the earlier `tool_use` block with the same id.
- Compaction: `{"type":"system","subtype":"compact_boundary"}`.
- Meta records carry `"isMeta": true` and must not count as user prompts.
- Largest single transcript is 9.4 MB and the whole corpus is 241 MB, so reading one file into memory and splitting on newlines is fine. No streaming machinery needed.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/parse.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseTranscript } from "../lib/parse.js";

function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe("parseTranscript", () => {
  it("collects usage from assistant turns", () => {
    const record = parseTranscript(
      lines({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 600,
          },
          content: [],
        },
      }),
      "sess-1",
    );

    expect(record.sessionId).toBe("sess-1");
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]!.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5000,
      cacheCreationTokens: 600,
    });
  });

  it("defaults missing usage fields to zero", () => {
    const record = parseTranscript(
      lines({ type: "assistant", message: { usage: { input_tokens: 7 } } }),
      "sess-1",
    );
    expect(record.turns[0]!.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("skips assistant records with no usage object", () => {
    const record = parseTranscript(
      lines({ type: "assistant", message: { content: [] } }),
      "sess-1",
    );
    expect(record.turns).toHaveLength(0);
  });

  it("records tool names used in a turn", () => {
    const record = parseTranscript(
      lines({
        type: "assistant",
        message: {
          usage: { input_tokens: 1 },
          content: [
            { type: "text", text: "ignored" },
            { type: "tool_use", id: "toolu_1", name: "Bash" },
            { type: "tool_use", id: "toolu_2", name: "Edit" },
          ],
        },
      }),
      "sess-1",
    );
    expect(record.turns[0]!.toolNames).toEqual(["Bash", "Edit"]);
  });

  it("attributes a tool result to the tool that produced it", () => {
    const record = parseTranscript(
      lines(
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 1 },
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
          },
        },
        {
          type: "user",
          toolUseResult: { stdout: "hello" },
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
        },
      ),
      "sess-1",
    );

    expect(record.toolResults).toHaveLength(1);
    expect(record.toolResults[0]!.toolName).toBe("Bash");
    expect(record.toolResults[0]!.bytes).toBe(
      JSON.stringify({ stdout: "hello" }).length,
    );
  });

  it("records an unattributable tool result with a null tool name", () => {
    const record = parseTranscript(
      lines({
        type: "user",
        toolUseResult: "orphan",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_missing" }] },
      }),
      "sess-1",
    );
    expect(record.toolResults[0]!.toolName).toBeNull();
  });

  it("counts real user prompts but not tool results or meta records", () => {
    const record = parseTranscript(
      lines(
        { type: "user", message: { content: "a real prompt" } },
        { type: "user", isMeta: true, message: { content: "injected context" } },
        {
          type: "user",
          toolUseResult: "x",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
        },
      ),
      "sess-1",
    );
    expect(record.userPrompts).toBe(1);
  });

  it("counts compact boundaries", () => {
    const record = parseTranscript(
      lines(
        { type: "system", subtype: "compact_boundary" },
        { type: "system", subtype: "turn_duration" },
      ),
      "sess-1",
    );
    expect(record.compactBoundaries).toBe(1);
  });

  it("ignores malformed lines instead of throwing", () => {
    const record = parseTranscript(
      ["not json at all", "", JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3 } } })],
      "sess-1",
    );
    expect(record.turns).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/__tests__/parse.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/parse.js"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/parse.ts`:

```typescript
import * as fs from "node:fs";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface Turn {
  usage: TurnUsage;
  toolNames: string[];
}

export interface ToolResultRecord {
  /** null when the originating tool_use block is not in this file. */
  toolName: string | null;
  bytes: number;
}

export interface SessionRecord {
  sessionId: string;
  turns: Turn[];
  toolResults: ToolResultRecord[];
  userPrompts: number;
  compactBoundaries: number;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one transcript's lines into aggregate counters.
 *
 * A tool result record does not carry the tool's name — only the
 * tool_use_id — so names are resolved from the tool_use blocks seen
 * earlier in the same file. A result whose tool_use is missing is kept
 * with a null name rather than dropped, so byte totals stay complete.
 */
export function parseTranscript(
  lines: Iterable<string>,
  sessionId: string,
): SessionRecord {
  const turns: Turn[] = [];
  const toolResults: ToolResultRecord[] = [];
  const toolNameById = new Map<string, string>();
  let userPrompts = 0;
  let compactBoundaries = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) continue;

    const message = asRecord(entry["message"]);
    const content = message ? message["content"] : undefined;

    if (entry["type"] === "assistant") {
      const usage = message ? asRecord(message["usage"]) : null;
      if (!usage) continue;

      const toolNames: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b || b["type"] !== "tool_use") continue;
          const name = typeof b["name"] === "string" ? b["name"] : null;
          const id = typeof b["id"] === "string" ? b["id"] : null;
          if (name) toolNames.push(name);
          if (name && id) toolNameById.set(id, name);
        }
      }

      turns.push({
        usage: {
          inputTokens: num(usage["input_tokens"]),
          outputTokens: num(usage["output_tokens"]),
          cacheReadTokens: num(usage["cache_read_input_tokens"]),
          cacheCreationTokens: num(usage["cache_creation_input_tokens"]),
        },
        toolNames,
      });
      continue;
    }

    if (entry["type"] === "user") {
      if (entry["toolUseResult"] !== undefined && entry["toolUseResult"] !== null) {
        let toolName: string | null = null;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = asRecord(block);
            if (!b || b["type"] !== "tool_result") continue;
            const id = b["tool_use_id"];
            if (typeof id === "string") toolName = toolNameById.get(id) ?? null;
          }
        }
        toolResults.push({
          toolName,
          bytes: JSON.stringify(entry["toolUseResult"]).length,
        });
        continue;
      }

      // A genuine user prompt: not a tool result, not injected context.
      if (entry["isMeta"] !== true) userPrompts += 1;
      continue;
    }

    if (entry["type"] === "system" && entry["subtype"] === "compact_boundary") {
      compactBoundaries += 1;
    }
  }

  return { sessionId, turns, toolResults, userPrompts, compactBoundaries };
}

/**
 * Read a transcript from disk. The largest transcript in the local corpus
 * is 9.4 MB, so whole-file reads are cheap enough to avoid a streaming
 * reader. An unreadable file yields an empty record rather than throwing,
 * so one bad file cannot abort a 644-file sweep.
 */
export function readTranscript(filePath: string, sessionId: string): SessionRecord {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      sessionId,
      turns: [],
      toolResults: [],
      userPrompts: 0,
      compactBoundaries: 0,
    };
  }
  return parseTranscript(text.split("\n"), sessionId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/__tests__/parse.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:scripts`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/parse.ts scripts/__tests__/parse.test.ts
git commit -m "Add transcript parser for token-efficiency research (#49)

Streams a Claude Code transcript into per-turn usage, tool-result sizes,
user prompt counts, and compaction boundaries.

Tool result records carry only a tool_use_id, not the tool name, so names
are resolved from the tool_use blocks seen earlier in the file. Results
whose tool_use is missing are kept with a null name rather than dropped,
so byte totals stay complete.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Corpus discovery and anonymisation

**Files:**
- Create: `scripts/lib/discover.ts`
- Test: `scripts/__tests__/discover.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces:
  - `interface SessionPaths { sessionId: string; projectLabel: string; mainPath: string; subagentPaths: string[] }`
  - `function projectLabel(index: number): string` — `0 -> "proj-a"`, `25 -> "proj-z"`, `26 -> "proj-aa"`
  - `function discoverSessions(projectsDir: string): SessionPaths[]`
  - `function defaultProjectsDir(): string` — `$HOME/.claude/projects`

**Corpus layout (established by inspection on 2026-07-31):**

```
~/.claude/projects/
  <project-dir>/
    <sessionId>.jsonl              <- main session transcript (90 of these)
    <sessionId>/
      subagents/agent-*.jsonl      <- subagent transcripts (555 of these)
      tool-results/                <- spilled large results; not token accounting
      memory/                      <- not token accounting
```

`isSidechain` is `false` on every record in the corpus, so subagent work is found **only** through the `subagents/` directory. Do not use that flag.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/discover.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSessions, projectLabel } from "../lib/discover.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-discover-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content = "{}\n"): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("projectLabel", () => {
  it("labels the first 26 projects with single letters", () => {
    expect(projectLabel(0)).toBe("proj-a");
    expect(projectLabel(25)).toBe("proj-z");
  });

  it("rolls over to two letters past 26", () => {
    expect(projectLabel(26)).toBe("proj-aa");
    expect(projectLabel(27)).toBe("proj-ab");
  });
});

describe("discoverSessions", () => {
  it("returns an empty list when the directory does not exist", () => {
    expect(discoverSessions(path.join(root, "nope"))).toEqual([]);
  });

  it("finds main session transcripts", () => {
    write("-Users-me-alpha/sess-1.jsonl");
    write("-Users-me-alpha/sess-2.jsonl");

    const found = discoverSessions(root);
    expect(found.map((s) => s.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("assigns stable anonymised labels in sorted directory order", () => {
    write("-Users-me-zebra/sess-1.jsonl");
    write("-Users-me-alpha/sess-2.jsonl");

    const byId = new Map(discoverSessions(root).map((s) => [s.sessionId, s.projectLabel]));
    expect(byId.get("sess-2")).toBe("proj-a"); // alpha sorts first
    expect(byId.get("sess-1")).toBe("proj-b");
  });

  it("attaches subagent transcripts to their parent session", () => {
    write("-Users-me-alpha/sess-1.jsonl");
    write("-Users-me-alpha/sess-1/subagents/agent-aaa.jsonl");
    write("-Users-me-alpha/sess-1/subagents/agent-bbb.jsonl");

    const [session] = discoverSessions(root);
    expect(session!.subagentPaths).toHaveLength(2);
  });

  it("ignores tool-results and memory directories", () => {
    write("-Users-me-alpha/sess-1.jsonl");
    write("-Users-me-alpha/sess-1/tool-results/big.jsonl");
    write("-Users-me-alpha/sess-1/memory/notes.jsonl");

    const [session] = discoverSessions(root);
    expect(session!.subagentPaths).toEqual([]);
  });

  it("emits no filesystem paths in the anonymised label", () => {
    write("-Users-me-secret-client-work/sess-1.jsonl");
    const [session] = discoverSessions(root);
    expect(session!.projectLabel).toBe("proj-a");
    expect(session!.projectLabel).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/__tests__/discover.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/discover.js"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/discover.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionPaths {
  sessionId: string;
  /** Anonymised project label, e.g. "proj-a". Never a real directory name. */
  projectLabel: string;
  mainPath: string;
  subagentPaths: string[];
}

/** 0 -> "proj-a", 25 -> "proj-z", 26 -> "proj-aa". */
export function projectLabel(index: number): string {
  let suffix = "";
  let n = index;
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `proj-${suffix}`;
}

export function defaultProjectsDir(): string {
  return path.join(process.env["HOME"] ?? "", ".claude", "projects");
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Enumerate main session transcripts and their subagent transcripts.
 *
 * Subagent work is found through the `subagents/` directory, NOT through
 * the `isSidechain` field — that field is false on every record in the
 * corpus, so a reader trusting it reports zero delegation and is silently
 * wrong. Sibling `tool-results/` and `memory/` directories are skipped:
 * they hold spilled payloads and notes, not token accounting.
 *
 * Project directories are sorted before labelling so labels are stable
 * across runs. Real directory names never leave this function.
 */
export function discoverSessions(projectsDir: string): SessionPaths[] {
  const projectDirs = listDir(projectsDir)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const sessions: SessionPaths[] = [];

  projectDirs.forEach((projectName, index) => {
    const label = projectLabel(index);
    const projectPath = path.join(projectsDir, projectName);

    for (const entry of listDir(projectPath)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      const sessionId = entry.name.slice(0, -".jsonl".length);
      const subagentDir = path.join(projectPath, sessionId, "subagents");
      const subagentPaths = listDir(subagentDir)
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(subagentDir, e.name))
        .sort();

      sessions.push({
        sessionId,
        projectLabel: label,
        mainPath: path.join(projectPath, entry.name),
        subagentPaths,
      });
    }
  });

  return sessions;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/__tests__/discover.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Sanity-check against the real corpus**

Run:
```bash
node --input-type=module -e '
import { discoverSessions, defaultProjectsDir } from "./scripts/lib/discover.js";
const s = discoverSessions(defaultProjectsDir());
console.log("main sessions:", s.length);
console.log("subagent transcripts:", s.reduce((n, x) => n + x.subagentPaths.length, 0));
console.log("projects:", new Set(s.map((x) => x.projectLabel)).size);
'
```
Expected: roughly `main sessions: 90`, `subagent transcripts: 555`, `projects: 22`. Exact counts may drift as new sessions are recorded — that is fine. A result of 0, or a subagent count of 0, means the discovery walk is wrong; stop and fix before continuing.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck:scripts`

```bash
git add scripts/lib/discover.ts scripts/__tests__/discover.test.ts
git commit -m "Add corpus discovery with anonymised project labels (#49)

Walks ~/.claude/projects for main session transcripts and the subagent
transcripts nested under <session>/subagents/. Subagent work is found via
that directory rather than the isSidechain field, which is false on every
record in the corpus — a reader trusting the flag reports zero delegation
and is silently wrong.

Project directories are sorted and mapped to proj-a..proj-z labels so real
directory names never reach the output. This repo is public and the corpus
includes client work.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Analysis stages

**Files:**
- Create: `scripts/lib/analysis.ts`
- Test: `scripts/__tests__/analysis.test.ts`

**Interfaces:**
- Consumes: `SessionRecord`, `Turn`, `TurnUsage` from `./parse.js`; `Summary`, `summarize`, `costEquivalent` from `./stats.js`.
- Produces:
  - `const MIN_TURNS = 5`
  - `interface SessionMetrics { projectLabel; turns; userPrompts; cacheHitRate; cacheReadPerTurn; cacheCreationPerTurn; outputPerTurn; totalCostEquivalent; cacheReadShare; outputShare; freshInputShare; cacheWriteShare; toolResultBytes; subagentCount; compactBoundaries }` (all `number` except `projectLabel: string`)
  - `function sessionMetrics(record: SessionRecord, projectLabel: string, subagentCount: number): SessionMetrics | null`
  - `function pearson(xs: number[], ys: number[]): number`
  - `interface ToolProfile { tool: string; calls: number; totalBytes: number; bytes: Summary }`
  - `function toolProfiles(records: SessionRecord[]): ToolProfile[]`
  - `interface DelegationComparison { sessionsWith: number; sessionsWithout: number; cacheReadPerTurnWith: Summary; cacheReadPerTurnWithout: Summary }`
  - `function compareDelegation(metrics: SessionMetrics[]): DelegationComparison`
  - `interface SignalScore { signal: string; availability: "stdin" | "transcript"; summary: Summary; dynamicRange: number; costCorrelation: number }`
  - `function scoreSignals(metrics: SessionMetrics[]): SignalScore[]`

`dynamicRange` is `p90 - p10`. `costCorrelation` is the Pearson correlation of the signal against `totalCostEquivalent` across sessions.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/analysis.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { SessionRecord } from "../lib/parse.js";
import {
  MIN_TURNS,
  sessionMetrics,
  pearson,
  toolProfiles,
  compareDelegation,
  scoreSignals,
} from "../lib/analysis.js";

function turn(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  toolNames: string[] = [],
) {
  return {
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
    toolNames,
  };
}

function record(turns: ReturnType<typeof turn>[], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess",
    turns,
    toolResults: [],
    userPrompts: 0,
    compactBoundaries: 0,
    ...extra,
  };
}

describe("sessionMetrics", () => {
  it("rejects sessions below the turn threshold", () => {
    expect(sessionMetrics(record([turn(1, 1, 1, 1)]), "proj-a", 0)).toBeNull();
  });

  it("computes the cache hit rate as reads over reads plus creations", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(0, 0, 900, 100));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    expect(m.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it("returns a zero hit rate when nothing was cached at all", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(10, 10, 0, 0));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    expect(m.cacheHitRate).toBe(0);
  });

  it("computes per-turn averages", () => {
    const turns = Array.from({ length: 10 }, () => turn(0, 20, 1000, 50));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    expect(m.turns).toBe(10);
    expect(m.cacheReadPerTurn).toBe(1000);
    expect(m.cacheCreationPerTurn).toBe(50);
    expect(m.outputPerTurn).toBe(20);
  });

  it("splits cost into shares that sum to one", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(100, 100, 100, 100));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    const total =
      m.cacheReadShare + m.outputShare + m.freshInputShare + m.cacheWriteShare;
    expect(total).toBeCloseTo(1, 10);
  });

  it("carries the anonymised label, subagent count and prompt count through", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(1, 1, 1, 1));
    const m = sessionMetrics(record(turns, { userPrompts: 4 }), "proj-c", 7)!;
    expect(m.projectLabel).toBe("proj-c");
    expect(m.subagentCount).toBe(7);
    expect(m.userPrompts).toBe(4);
  });
});

describe("pearson", () => {
  it("is 1 for a perfectly increasing relationship", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("is -1 for a perfectly decreasing relationship", () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it("is 0 when one series has no variance", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it("is 0 for fewer than two points", () => {
    expect(pearson([1], [1])).toBe(0);
  });
});

describe("toolProfiles", () => {
  it("aggregates result sizes per tool, largest total first", () => {
    const r = record([], {
      toolResults: [
        { toolName: "Bash", bytes: 100 },
        { toolName: "Bash", bytes: 300 },
        { toolName: "Read", bytes: 50 },
      ],
    });

    const profiles = toolProfiles([r]);
    expect(profiles[0]!.tool).toBe("Bash");
    expect(profiles[0]!.calls).toBe(2);
    expect(profiles[0]!.totalBytes).toBe(400);
    expect(profiles[0]!.bytes.p50).toBe(200);
    expect(profiles[1]!.tool).toBe("Read");
  });

  it("buckets unattributable results under a named placeholder", () => {
    const r = record([], { toolResults: [{ toolName: null, bytes: 10 }] });
    expect(toolProfiles([r])[0]!.tool).toBe("(unattributed)");
  });
});

describe("compareDelegation", () => {
  it("splits sessions by whether they used subagents", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(0, 0, 1000, 0));
    const withSub = sessionMetrics(record(turns), "proj-a", 3)!;
    const withoutSub = sessionMetrics(record(turns), "proj-b", 0)!;

    const cmp = compareDelegation([withSub, withoutSub]);
    expect(cmp.sessionsWith).toBe(1);
    expect(cmp.sessionsWithout).toBe(1);
    expect(cmp.cacheReadPerTurnWith.n).toBe(1);
  });
});

describe("scoreSignals", () => {
  /** A spread of sessions of differing scale, so percentiles actually differ. */
  function spread(): ReturnType<typeof sessionMetrics>[] {
    return [1, 2, 3, 4, 5].map((k) =>
      sessionMetrics(
        record(Array.from({ length: MIN_TURNS }, () => turn(0, 10 * k, 1000 * k, 100))),
        "proj-a",
        0,
      ),
    );
  }

  it("scores every candidate signal with a finite dynamic range", () => {
    const scores = scoreSignals(spread().filter((m) => m !== null));
    const names = scores.map((s) => s.signal);
    expect(names).toContain("cache-hit-rate");
    expect(names).toContain("cache-read-per-turn");
    expect(scores.every((s) => Number.isFinite(s.dynamicRange))).toBe(true);
  });

  it("marks which signals the live stdin payload can support", () => {
    const scores = scoreSignals(spread().filter((m) => m !== null));
    expect(scores.find((s) => s.signal === "cache-hit-rate")!.availability).toBe("stdin");
    expect(scores.find((s) => s.signal === "cache-read-per-turn")!.availability).toBe(
      "transcript",
    );
  });
});
```

Note: in the first `scoreSignals` test, `sessionMetrics` is called with an array rather than a `SessionRecord` on the `metrics` line — that is deliberate dead weight removed by `void metrics`. If TypeScript rejects it, delete the `metrics` constant and the `void metrics;` line entirely; only `many` matters.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/__tests__/analysis.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/analysis.js"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/analysis.ts`:

```typescript
import type { SessionRecord } from "./parse.js";
import { type Summary, summarize, costEquivalent, COST_WEIGHTS } from "./stats.js";

/** Sessions below this many assistant turns are too short to characterise. */
export const MIN_TURNS = 5;

export interface SessionMetrics {
  projectLabel: string;
  turns: number;
  /** Genuine user prompts — not tool results, not injected context. */
  userPrompts: number;
  cacheHitRate: number;
  cacheReadPerTurn: number;
  cacheCreationPerTurn: number;
  outputPerTurn: number;
  /** Total session cost in input-token-equivalents. */
  totalCostEquivalent: number;
  cacheReadShare: number;
  outputShare: number;
  freshInputShare: number;
  cacheWriteShare: number;
  toolResultBytes: number;
  subagentCount: number;
  compactBoundaries: number;
}

export function sessionMetrics(
  record: SessionRecord,
  projectLabel: string,
  subagentCount: number,
): SessionMetrics | null {
  const turns = record.turns;
  if (turns.length < MIN_TURNS) return null;

  let input = 0;
  let output = 0;
  let reads = 0;
  let creations = 0;
  for (const t of turns) {
    input += t.usage.inputTokens;
    output += t.usage.outputTokens;
    reads += t.usage.cacheReadTokens;
    creations += t.usage.cacheCreationTokens;
  }

  const cached = reads + creations;
  const total = costEquivalent({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: reads,
    cacheCreationTokens: creations,
  });
  const share = (weighted: number) => (total === 0 ? 0 : weighted / total);

  return {
    projectLabel,
    turns: turns.length,
    userPrompts: record.userPrompts,
    cacheHitRate: cached === 0 ? 0 : reads / cached,
    cacheReadPerTurn: reads / turns.length,
    cacheCreationPerTurn: creations / turns.length,
    outputPerTurn: output / turns.length,
    totalCostEquivalent: total,
    cacheReadShare: share(reads * COST_WEIGHTS.cacheRead),
    outputShare: share(output * COST_WEIGHTS.output),
    freshInputShare: share(input * COST_WEIGHTS.input),
    cacheWriteShare: share(creations * COST_WEIGHTS.cacheWrite),
    toolResultBytes: record.toolResults.reduce((n, r) => n + r.bytes, 0),
    subagentCount,
    compactBoundaries: record.compactBoundaries,
  };
}

/** Pearson correlation. Returns 0 when either series has no variance. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  const meanX = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

export interface ToolProfile {
  tool: string;
  calls: number;
  totalBytes: number;
  bytes: Summary;
}

const UNATTRIBUTED = "(unattributed)";

/** Result-size distribution per tool, ordered by total bytes descending. */
export function toolProfiles(records: SessionRecord[]): ToolProfile[] {
  const byTool = new Map<string, number[]>();
  for (const record of records) {
    for (const result of record.toolResults) {
      const key = result.toolName ?? UNATTRIBUTED;
      const bucket = byTool.get(key);
      if (bucket) bucket.push(result.bytes);
      else byTool.set(key, [result.bytes]);
    }
  }

  return [...byTool.entries()]
    .map(([tool, sizes]) => ({
      tool,
      calls: sizes.length,
      totalBytes: sizes.reduce((a, b) => a + b, 0),
      bytes: summarize(sizes),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

export interface DelegationComparison {
  sessionsWith: number;
  sessionsWithout: number;
  cacheReadPerTurnWith: Summary;
  cacheReadPerTurnWithout: Summary;
}

/**
 * Does delegating to subagents slow the main context's growth? Compares
 * cache_read per turn — the dominant cost term — between sessions that
 * spawned subagents and sessions that did not.
 */
export function compareDelegation(metrics: SessionMetrics[]): DelegationComparison {
  const withSub = metrics.filter((m) => m.subagentCount > 0);
  const withoutSub = metrics.filter((m) => m.subagentCount === 0);
  return {
    sessionsWith: withSub.length,
    sessionsWithout: withoutSub.length,
    cacheReadPerTurnWith: summarize(withSub.map((m) => m.cacheReadPerTurn)),
    cacheReadPerTurnWithout: summarize(withoutSub.map((m) => m.cacheReadPerTurn)),
  };
}

export interface SignalScore {
  signal: string;
  /** Whether a live statusline payload can compute this, or only a transcript read can. */
  availability: "stdin" | "transcript";
  summary: Summary;
  /** p90 - p10: how far the signal actually moves across real sessions. */
  dynamicRange: number;
  /** Pearson correlation against total session cost. */
  costCorrelation: number;
}

const CANDIDATES: Array<{
  signal: string;
  availability: "stdin" | "transcript";
  pick: (m: SessionMetrics) => number;
}> = [
  { signal: "cache-hit-rate", availability: "stdin", pick: (m) => m.cacheHitRate },
  { signal: "cache-read-per-turn", availability: "transcript", pick: (m) => m.cacheReadPerTurn },
  { signal: "cache-creation-per-turn", availability: "transcript", pick: (m) => m.cacheCreationPerTurn },
  { signal: "output-per-turn", availability: "transcript", pick: (m) => m.outputPerTurn },
  { signal: "cache-read-share-of-cost", availability: "stdin", pick: (m) => m.cacheReadShare },
  { signal: "output-share-of-cost", availability: "stdin", pick: (m) => m.outputShare },
];

export function scoreSignals(metrics: SessionMetrics[]): SignalScore[] {
  const costs = metrics.map((m) => m.totalCostEquivalent);
  return CANDIDATES.map(({ signal, availability, pick }) => {
    const values = metrics.map(pick);
    const summary = summarize(values);
    return {
      signal,
      availability,
      summary,
      dynamicRange: summary.p90 - summary.p10,
      costCorrelation: pearson(values, costs),
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/__tests__/analysis.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:scripts`

```bash
git add scripts/lib/analysis.ts scripts/__tests__/analysis.test.ts
git commit -m "Add analysis stages for token-efficiency research (#49)

Per-session metrics, cost decomposition into shares, per-tool result-size
profiles, the subagent-delegation comparison, and candidate signal scoring
on dynamic range and cost correlation.

Dynamic range is p90 minus p10 — the question a statusline meter actually
has to answer is whether a number moves far enough across real sessions to
be readable, not whether it is theoretically meaningful.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Report rendering and CLI

**Files:**
- Create: `scripts/lib/report.ts`
- Create: `scripts/analyze-transcripts.ts`
- Test: `scripts/__tests__/report.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `interface Report { corpus: {...}; decomposition: {...}; tools: ToolProfile[]; delegation: DelegationComparison; signals: SignalScore[]; sessions: SessionMetrics[] }`
  - `function buildReport(projectsDir: string): Report`
  - `function renderMarkdown(report: Report): string`

The CLI entry parses `--json` and `--projects-dir <path>`, calls `buildReport`, and prints either `JSON.stringify(report, null, 2)` or `renderMarkdown(report)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/report.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildReport, renderMarkdown } from "../lib/report.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-report-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a transcript with `turns` assistant turns and one Bash tool result. */
function seedSession(projectDir: string, sessionId: string, turns: number, subagents = 0): void {
  const dir = path.join(root, projectDir);
  fs.mkdirSync(dir, { recursive: true });

  const records: unknown[] = [];
  for (let i = 0; i < turns; i += 1) {
    records.push({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 2_000,
        },
        content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash" }],
      },
    });
    records.push({
      type: "user",
      toolUseResult: { stdout: "x".repeat(500) },
      message: { content: [{ type: "tool_result", tool_use_id: `toolu_${i}` }] },
    });
  }
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );

  if (subagents > 0) {
    const subDir = path.join(dir, sessionId, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    for (let i = 0; i < subagents; i += 1) {
      fs.writeFileSync(path.join(subDir, `agent-${i}.jsonl`), "{}\n");
    }
  }
}

describe("buildReport", () => {
  it("counts the corpus it analysed", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    seedSession("-Users-me-beta", "sess-2", 10, 3);

    const report = buildReport(root);
    expect(report.corpus.mainSessions).toBe(2);
    expect(report.corpus.analysedSessions).toBe(2);
    expect(report.corpus.subagentTranscripts).toBe(3);
    expect(report.corpus.projects).toBe(2);
  });

  it("excludes sessions below the turn threshold from analysis", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    seedSession("-Users-me-alpha", "sess-short", 2);

    const report = buildReport(root);
    expect(report.corpus.mainSessions).toBe(2);
    expect(report.corpus.analysedSessions).toBe(1);
  });

  it("profiles tool result sizes", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    const report = buildReport(root);
    expect(report.tools[0]!.tool).toBe("Bash");
    expect(report.tools[0]!.calls).toBe(10);
  });

  it("scores every candidate signal", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    seedSession("-Users-me-beta", "sess-2", 20);
    const report = buildReport(root);
    expect(report.signals.length).toBeGreaterThanOrEqual(6);
  });

  it("emits no real project directory names anywhere in the report", () => {
    seedSession("-Users-me-confidential-client", "sess-1", 10);
    const serialized = JSON.stringify(buildReport(root));
    expect(serialized).not.toContain("confidential");
    expect(serialized).not.toContain(root);
  });
});

describe("renderMarkdown", () => {
  it("renders headed sections a document can quote", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    const md = renderMarkdown(buildReport(root));
    expect(md).toContain("## Corpus");
    expect(md).toContain("## Cost decomposition");
    expect(md).toContain("## Tool result sizes");
    expect(md).toContain("## Candidate signals");
  });

  it("leaks no directory names into the markdown", () => {
    seedSession("-Users-me-confidential-client", "sess-1", 10);
    const md = renderMarkdown(buildReport(root));
    expect(md).not.toContain("confidential");
  });
});

describe("CLI", () => {
  it("prints markdown by default and JSON with --json", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);

    const md = execFileSync(
      process.execPath,
      ["scripts/analyze-transcripts.ts", "--projects-dir", root],
      { encoding: "utf8" },
    );
    expect(md).toContain("## Corpus");

    const json = execFileSync(
      process.execPath,
      ["scripts/analyze-transcripts.ts", "--projects-dir", root, "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(json).corpus.mainSessions).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/__tests__/report.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/report.js"`.

- [ ] **Step 3: Write the report module**

Create `scripts/lib/report.ts`:

```typescript
import { discoverSessions } from "./discover.js";
import { readTranscript, type SessionRecord } from "./parse.js";
import { summarize, type Summary } from "./stats.js";
import {
  MIN_TURNS,
  sessionMetrics,
  toolProfiles,
  compareDelegation,
  scoreSignals,
  type SessionMetrics,
  type ToolProfile,
  type DelegationComparison,
  type SignalScore,
} from "./analysis.js";

export interface Report {
  corpus: {
    projects: number;
    mainSessions: number;
    subagentTranscripts: number;
    analysedSessions: number;
    minTurns: number;
    assistantTurns: number;
    compactBoundaries: number;
  };
  decomposition: {
    cacheReadShare: Summary;
    outputShare: Summary;
    freshInputShare: Summary;
    cacheWriteShare: Summary;
    cacheReadPerTurn: Summary;
    cacheCreationPerTurn: Summary;
    outputPerTurn: Summary;
    turnsPerSession: Summary;
    userPromptsPerSession: Summary;
    /** Assistant turns per user prompt — how much work one ask costs. */
    turnsPerPrompt: Summary;
  };
  tools: ToolProfile[];
  delegation: DelegationComparison;
  signals: SignalScore[];
  sessions: SessionMetrics[];
}

export function buildReport(projectsDir: string): Report {
  const paths = discoverSessions(projectsDir);
  const records: SessionRecord[] = [];
  const metrics: SessionMetrics[] = [];
  let subagentTranscripts = 0;

  for (const p of paths) {
    const record = readTranscript(p.mainPath, p.sessionId);
    records.push(record);
    subagentTranscripts += p.subagentPaths.length;

    const m = sessionMetrics(record, p.projectLabel, p.subagentPaths.length);
    if (m) metrics.push(m);
  }

  return {
    corpus: {
      projects: new Set(paths.map((p) => p.projectLabel)).size,
      mainSessions: paths.length,
      subagentTranscripts,
      analysedSessions: metrics.length,
      minTurns: MIN_TURNS,
      assistantTurns: metrics.reduce((n, m) => n + m.turns, 0),
      compactBoundaries: records.reduce((n, r) => n + r.compactBoundaries, 0),
    },
    decomposition: {
      cacheReadShare: summarize(metrics.map((m) => m.cacheReadShare)),
      outputShare: summarize(metrics.map((m) => m.outputShare)),
      freshInputShare: summarize(metrics.map((m) => m.freshInputShare)),
      cacheWriteShare: summarize(metrics.map((m) => m.cacheWriteShare)),
      cacheReadPerTurn: summarize(metrics.map((m) => m.cacheReadPerTurn)),
      cacheCreationPerTurn: summarize(metrics.map((m) => m.cacheCreationPerTurn)),
      outputPerTurn: summarize(metrics.map((m) => m.outputPerTurn)),
      turnsPerSession: summarize(metrics.map((m) => m.turns)),
      userPromptsPerSession: summarize(metrics.map((m) => m.userPrompts)),
      turnsPerPrompt: summarize(
        metrics.filter((m) => m.userPrompts > 0).map((m) => m.turns / m.userPrompts),
      ),
    },
    tools: toolProfiles(records),
    delegation: compareDelegation(metrics),
    signals: scoreSignals(metrics),
    sessions: metrics,
  };
}

function n0(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "n/a";
}

function n1(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "n/a";
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function summaryRow(label: string, s: Summary, format: (v: number) => string): string {
  return `| ${label} | ${format(s.p10)} | ${format(s.p50)} | ${format(s.p90)} | ${format(s.max)} |`;
}

export function renderMarkdown(report: Report): string {
  const { corpus, decomposition, tools, delegation, signals } = report;
  const out: string[] = [];

  out.push("## Corpus", "");
  out.push(`- Projects: ${corpus.projects}`);
  out.push(`- Main session transcripts: ${corpus.mainSessions}`);
  out.push(`- Subagent transcripts: ${corpus.subagentTranscripts}`);
  out.push(`- Sessions analysed (>= ${corpus.minTurns} assistant turns): ${corpus.analysedSessions}`);
  out.push(`- Assistant turns analysed: ${n0(corpus.assistantTurns)}`);
  out.push(`- Compaction boundaries observed: ${corpus.compactBoundaries}`);
  out.push("");

  out.push("## Cost decomposition", "");
  out.push("Share of session cost in input-token-equivalents (output 5x, cache write 1.25x, cache read 0.1x).", "");
  out.push("| Component | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("Cache reads", decomposition.cacheReadShare, pct));
  out.push(summaryRow("Output", decomposition.outputShare, pct));
  out.push(summaryRow("Fresh input", decomposition.freshInputShare, pct));
  out.push(summaryRow("Cache writes", decomposition.cacheWriteShare, pct));
  out.push("");
  out.push("| Per-turn tokens | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("Cache read", decomposition.cacheReadPerTurn, n0));
  out.push(summaryRow("Cache creation", decomposition.cacheCreationPerTurn, n0));
  out.push(summaryRow("Output", decomposition.outputPerTurn, n0));
  out.push("");
  out.push("| Session shape | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("Assistant turns", decomposition.turnsPerSession, n0));
  out.push(summaryRow("User prompts", decomposition.userPromptsPerSession, n0));
  out.push(summaryRow("Turns per prompt", decomposition.turnsPerPrompt, n1));
  out.push("");

  out.push("## Tool result sizes", "");
  out.push("| Tool | Calls | Total bytes | p50 | p90 | p99 | max |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tools.slice(0, 15)) {
    out.push(
      `| ${t.tool} | ${n0(t.calls)} | ${n0(t.totalBytes)} | ${n0(t.bytes.p50)} | ${n0(t.bytes.p90)} | ${n0(t.bytes.p99)} | ${n0(t.bytes.max)} |`,
    );
  }
  if (tools.length > 15) out.push("", `_${tools.length - 15} further tools omitted from this table._`);
  out.push("");

  out.push("## Subagent delegation", "");
  out.push(`- Sessions that spawned subagents: ${delegation.sessionsWith}`);
  out.push(`- Sessions that did not: ${delegation.sessionsWithout}`);
  out.push("");
  out.push("| Cache read per turn | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("With subagents", delegation.cacheReadPerTurnWith, n0));
  out.push(summaryRow("Without subagents", delegation.cacheReadPerTurnWithout, n0));
  out.push("");

  out.push("## Candidate signals", "");
  out.push("| Signal | Available from | p10 | p50 | p90 | Dynamic range (p90-p10) | Cost correlation |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of signals) {
    const isShare = s.signal.includes("share") || s.signal === "cache-hit-rate";
    const f = isShare ? pct : n0;
    out.push(
      `| ${s.signal} | ${s.availability} | ${f(s.summary.p10)} | ${f(s.summary.p50)} | ${f(s.summary.p90)} | ${f(s.dynamicRange)} | ${s.costCorrelation.toFixed(2)} |`,
    );
  }
  out.push("");

  return out.join("\n");
}
```

- [ ] **Step 4: Write the CLI entry**

Create `scripts/analyze-transcripts.ts`:

```typescript
/**
 * Transcript analysis for issue #49 — what a token-efficiency meter should measure.
 *
 * Requires Node >= 23.6, which strips TypeScript types natively. On older
 * Node this file fails to parse; there is no build step and no dependency
 * to install.
 *
 *   npm run analyze                    # markdown tables
 *   npm run analyze -- --json          # machine-readable aggregates
 *   npm run analyze -- --projects-dir /path/to/projects
 *
 * Output is anonymised: project directories are reported as proj-a, proj-b,
 * and so on, and no prompt text, file contents, or paths are ever emitted.
 */
import { defaultProjectsDir } from "./lib/discover.js";
import { buildReport, renderMarkdown } from "./lib/report.js";

function main(argv: string[]): void {
  const asJson = argv.includes("--json");
  const dirFlag = argv.indexOf("--projects-dir");
  const projectsDir = dirFlag !== -1 ? argv[dirFlag + 1] : undefined;

  if (dirFlag !== -1 && !projectsDir) {
    console.error("--projects-dir requires a path");
    process.exit(1);
  }

  const report = buildReport(projectsDir ?? defaultProjectsDir());
  process.stdout.write(
    asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`,
  );
}

main(process.argv.slice(2));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/__tests__/report.test.ts`
Expected: PASS, 8 tests.

If the CLI test fails with a syntax error on the `.ts` file, check `node --version` — native type stripping needs ≥23.6. This machine had v26.5.0 at plan time.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck && npm run typecheck:scripts`
Expected: everything passes. `npm run typecheck` covers `src/` (unchanged); `typecheck:scripts` covers the new code.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/report.ts scripts/analyze-transcripts.ts scripts/__tests__/report.test.ts
git commit -m "Add analyze-transcripts CLI and report rendering (#49)

Assembles discovery, parsing, and analysis into one report, rendered as
markdown tables for the findings document or JSON for further work.

Tests build a synthetic corpus in a tmpdir and assert, among other things,
that no real project directory name survives into either output — the
corpus this runs against includes client work and this repo is public.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Run the analysis and write the findings document

**Files:**
- Create: `docs/research/token-efficiency.md`
- Read: output of `npm run analyze`

**Interfaces:**
- Consumes: `npm run analyze` (markdown) and `npm run analyze -- --json` (aggregates) from Task 5.
- Produces: the deliverable named in issue #49.

This task has no failing-test cycle — the deliverable is a written document. Its verification is that every figure in it traces to script output and that the required conclusions are present.

- [ ] **Step 1: Capture the analysis output**

```bash
SCRATCH=/private/tmp/claude-501/-Users-gpietro-projects-gccusage/0937061d-2750-4dad-abbf-0a4ebf9f85c1/scratchpad
npm run analyze > "$SCRATCH/analysis.md"
npm run analyze -- --json > "$SCRATCH/analysis.json"
wc -l "$SCRATCH/analysis.md" "$SCRATCH/analysis.json"
```

Expected: both files non-empty. Read `analysis.md` in full before writing anything.

- [ ] **Step 2: Sanity-check against the spec's preliminary readings**

Compare the script's cache-hit-rate and per-turn figures against the spec's scoping-probe numbers (p10 93.3% / p50 97.5% / p90 98.9%; cache_read per turn p10 49.8k / p50 125.1k / p90 254.8k).

Small differences are expected — the script interpolates percentiles and the probe used floor-index selection. A gap of more than about 1 percentage point on the hit rate, or more than ~5% on the per-turn figures, means the script and the probe disagree about something real. If that happens, **stop and investigate before writing the document** — the discrepancy is itself a finding, and writing around it would bury it.

- [ ] **Step 3: Write the findings document**

Create `docs/research/token-efficiency.md` with these sections, in this order. Fill every figure from the captured output — do not carry over the spec's preliminary readings, which were throwaway probes.

1. **Recommendation** — up front, before any evidence. Name the signal (or state positively that none qualifies), its thresholds, and one line on why. A reader deciding what to build must not have to read four stages first.
2. **Thresholds and what each state means** — a table of state → numeric range → the action it implies. If a state implies no action a user can take mid-session, say so rather than inventing advice.
3. **What the corpus is** — counts from `report.corpus`, the layout, and the biases: one user, one machine, work skewed toward this repo and ServiceNow consulting. Include the `isSidechain` finding.
4. **Where the tokens go** — the cost decomposition table and the per-turn table. State plainly which component dominates.
5. **Tool result sizes** — the per-tool table, with attention to the tail rather than the median.
6. **Levers** — for each source in §4, whether a user can change it mid-session. Cover turn count against a large window, oversized tool results, subagent delegation (using the delegation comparison), and compaction (report the observed `compactBoundaries` count and what it implies).
7. **Candidate evaluation** — the signal table, then the **ruled-out table**: one row per rejected signal with a specific reason. Not "not useful" but e.g. "cache hit rate — p10-to-p90 range is N points, below what a statusline segment can render distinguishably". All four candidates from issue #49 must appear.
8. **Disposition of `cache-hit-rate`** — keep as the meter's foundation, or retire the widget. Reference issue #47.
9. **Limitations** — what this corpus cannot answer.
10. **Reproducing** — `npm run analyze`, the `--json` flag, the Node version requirement.

- [ ] **Step 4: Verify every number traces to script output**

Go through the document and confirm each figure appears in `$SCRATCH/analysis.md` or `$SCRATCH/analysis.json`. Delete or re-derive anything that does not. A number in the document that the script cannot regenerate defeats the point of committing the script.

- [ ] **Step 5: Verify the "done" criteria from the spec**

Confirm each of these before committing:

- `npm run analyze` runs clean and prints both output modes.
- Every number in the document traces to script output.
- The document names a specific signal with thresholds and per-state advice, **or** states positively that no signal qualifies and gives the reason.
- The ruled-out table covers all four candidates from issue #49 with a specific reason each.
- `cache-hit-rate` is explicitly dispositioned.
- `npm test`, `npm run typecheck`, and `npm run typecheck:scripts` all pass.

Run: `npm test && npm run typecheck && npm run typecheck:scripts`

- [ ] **Step 6: Commit**

```bash
git add docs/research/token-efficiency.md
git commit -m "Add token-efficiency findings and meter recommendation (#49)

Closes the research that blocks the token-efficiency meter widget: what
the meter should measure, the thresholds, and the advice each state
implies — derived from the local transcript corpus rather than chosen by
intuition.

Records what was ruled out and why, including a disposition for the
dormant cache-hit-rate widget (#47), so the metric choice does not get
reopened from scratch later.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Report the outcome**

Summarise for the user: the recommended signal and thresholds, the strongest surprise from the data, and the `cache-hit-rate` disposition. Do **not** open a PR or merge without asking — that is the user's call (see superpowers:finishing-a-development-branch).

---

## Notes for the implementer

- **The corpus is live data.** Counts will drift between plan time and run time as new sessions are recorded. Treat the plan's figures (90 main sessions, 555 subagent transcripts, 22 projects) as approximate expectations, not assertions to match exactly.
- **If a finding contradicts the spec, the finding wins.** The spec's preliminary readings came from throwaway probes. The committed script is the authority; a disagreement is a result to report, not an error to paper over.
- **Do not add a dependency to solve a small problem.** Percentiles, correlation, and markdown tables are all a few lines each. A new devDependency for any of them is out of scope.
