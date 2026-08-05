import { describe, it, expect } from "vitest";
import { aggregateTokens, getFirstTimestamp, countHumanTurns } from "../data/token-aggregator.js";
import type { JsonlEntry } from "../data/jsonl-reader.js";

describe("aggregateTokens", () => {
  const entries: JsonlEntry[] = [
    {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 1000, output_tokens: 500 },
    },
    {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 2000, output_tokens: 800 },
    },
    {
      model: "claude-opus-4-20250514",
      usage: { input_tokens: 5000, output_tokens: 2000 },
    },
  ];

  it("aggregates totals across every entry", () => {
    const result = aggregateTokens(entries);
    expect(result.totals.inputTokens).toBe(8000);
    expect(result.totals.outputTokens).toBe(3300);
  });

  it("aggregates by model", () => {
    const result = aggregateTokens(entries);
    expect(result.byModel.size).toBe(2);
    expect(result.byModel.get("claude-sonnet-4-20250514")?.inputTokens).toBe(3000);
    expect(result.byModel.get("claude-opus-4-20250514")?.inputTokens).toBe(5000);
  });

  // An entry with usage but no `model` counts toward the totals and toward no
  // model bucket. This asymmetry is why the cache in
  // `today-aggregate-cache.ts` stores `totals` as well as `byModel`: the
  // totals cannot be reconstructed by summing the buckets.
  it("counts model-less usage in totals but not in byModel", () => {
    const result = aggregateTokens([{ usage: { input_tokens: 100, output_tokens: 50 } }]);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.byModel.size).toBe(0);
  });

  it("returns zeroed totals for no entries", () => {
    const result = aggregateTokens([]);
    expect(result.totals.inputTokens).toBe(0);
    expect(result.byModel.size).toBe(0);
  });
});

function entry(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation_1h_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): JsonlEntry {
  return { model, usage } as JsonlEntry;
}

describe("getFirstTimestamp", () => {
  it("returns first valid timestamp", () => {
    const entries: JsonlEntry[] = [
      { timestamp: "2025-01-15T10:00:00Z" },
      { timestamp: "2025-01-15T10:01:00Z" },
    ];
    expect(getFirstTimestamp(entries)).toBe(new Date("2025-01-15T10:00:00Z").getTime());
  });

  it("returns null for no timestamps", () => {
    expect(getFirstTimestamp([{}])).toBeNull();
  });
});

describe("aggregateTokens premium bucketing (#103)", () => {
  it("leaves the premium bucket empty for a prompt under the threshold", () => {
    const { byModel, totals } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 1000, output_tokens: 500 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    });
    expect(totals.premium!.inputTokens).toBe(0);
  });

  it("treats a prompt of exactly 200_000 as standard", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 200_000, output_tokens: 10 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.inputTokens).toBe(0);
  });

  it("buckets a prompt of 200_001 as premium", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 200_001, output_tokens: 10 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.inputTokens).toBe(200_001);
  });

  it("counts cache reads and cache creation toward the prompt size", () => {
    // 190k cached + 20k fresh is a 210k prompt, even though input_tokens alone
    // is far under the threshold. This is the shape of a real long session.
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", {
        input_tokens: 20_000,
        cache_read_input_tokens: 190_000,
        output_tokens: 700,
      }),
    ]);

    const premium = byModel.get("claude-opus-5")!.premium!;
    expect(premium.inputTokens).toBe(20_000);
    expect(premium.cacheReadTokens).toBe(190_000);
  });

  it("bills a premium request's output tokens at the premium tier", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 300_000, output_tokens: 800 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.outputTokens).toBe(800);
  });

  it("keeps the base counts as full totals, not standard-only", () => {
    // The regression guard for every token-count widget: they read these four
    // fields and must keep seeing everything the session used.
    const { byModel, totals } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 300_000, output_tokens: 800 }),
      entry("claude-opus-5", { input_tokens: 1_000, output_tokens: 200 }),
    ]);

    const metrics = byModel.get("claude-opus-5")!;
    expect(metrics.inputTokens).toBe(301_000);
    expect(metrics.outputTokens).toBe(1_000);
    expect(metrics.premium!.inputTokens).toBe(300_000);
    expect(totals.inputTokens).toBe(301_000);
    expect(totals.premium!.inputTokens).toBe(300_000);
  });

  it("sums premium across entries per model", () => {
    const { byModel } = aggregateTokens([
      entry("claude-opus-5", { input_tokens: 250_000, output_tokens: 100 }),
      entry("claude-sonnet-5", { input_tokens: 400_000, output_tokens: 100 }),
      entry("claude-opus-5", { input_tokens: 210_000, output_tokens: 100 }),
    ]);

    expect(byModel.get("claude-opus-5")!.premium!.inputTokens).toBe(460_000);
    expect(byModel.get("claude-sonnet-5")!.premium!.inputTokens).toBe(400_000);
  });
});

describe("aggregateTokens 1-hour cache write bucketing (#118)", () => {
  // Two entries with DIFFERING 1-hour counts: a fixture where every entry
  // used the same 1-hour count would still pass if the accumulation summed
  // the wrong field, as long as it summed *something* proportional. Distinct
  // counts (400 and 100) make the total (500) unreachable by that class of
  // mistake.
  it("sums cacheCreation1hTokens across entries, alongside the full cacheCreationTokens", () => {
    const { totals } = aggregateTokens([
      entry("claude-opus-5", {
        cache_creation_input_tokens: 1000,
        cache_creation_1h_input_tokens: 400,
      }),
      entry("claude-opus-5", {
        cache_creation_input_tokens: 500,
        cache_creation_1h_input_tokens: 100,
      }),
    ]);

    expect(totals.cacheCreation1hTokens).toBe(500);
    expect(totals.cacheCreationTokens).toBe(1500);
  });
});

describe("countHumanTurns", () => {
  // Shapes taken from real transcripts (three sessions sampled for the design
  // spec). Every one of these is `type: "user"` — which is why counting
  // `type === "user"` over-counts by ~5x and origin.kind is the real signal.
  //
  // There is deliberately no case for `promptSource`. Its human variants
  // (typed / suggestion_accepted / queued) all carry origin.kind "human", and
  // the field is not on JsonlEntry at all — a test distinguishing them would
  // compare two identical fixtures and could not be broken by any mutation to
  // the rule it claims to guard.
  const HUMAN = { type: "user", originKind: "human" };
  const NOTIFICATION = { type: "user", originKind: "task-notification" };
  // Subagent sidechain prompt. Defensive-only, same category as
  // HUMAN_WRONG_TYPE below: in the current transcript layout, sidechain
  // entries live under `<sessionId>/subagents/*.jsonl`, and `findJsonlFiles`
  // (src/utils/paths.ts) does not recurse into subdirectories, so gccusage
  // never actually parses them today — a 190-transcript corpus probe found
  // `isSidechain: 0` and `originKind: "coordinator"` count 0 across every
  // file gccusage reads. Kept, not deleted, as a guard against a future
  // format change (e.g. sidechains moving into the main transcript file)
  // reaching this function unfiltered.
  const COORDINATOR = { type: "user", originKind: "coordinator" };
  const TOOL_RESULT = { type: "user" }; // content is a tool_result array; no origin
  const META = { type: "user" }; // isMeta text; no origin
  const ASSISTANT = { type: "assistant", originKind: undefined };
  // Isolates the `type === "user"` half of the conjunct. No real transcript
  // pairs a non-user type with origin.kind "human" today (0 of 3,212 origin
  // objects across 400 sampled transcripts sit on a non-user line), but
  // nothing in jsonl-reader gates originKind on type — so without this
  // fixture, deleting the type check breaks no test.
  const HUMAN_WRONG_TYPE = { type: "assistant", originKind: "human" };

  it("counts only entries whose origin is human", () => {
    expect(countHumanTurns([HUMAN, NOTIFICATION, TOOL_RESULT, HUMAN])).toBe(2);
  });

  it("excludes task notifications", () => {
    expect(countHumanTurns([NOTIFICATION, NOTIFICATION, NOTIFICATION])).toBe(0);
  });

  it("excludes tool results and meta entries, which carry no origin", () => {
    expect(countHumanTurns([TOOL_RESULT, META, TOOL_RESULT])).toBe(0);
  });

  it("excludes subagent sidechain prompts", () => {
    expect(countHumanTurns([COORDINATOR, HUMAN])).toBe(1);
  });

  it("excludes assistant entries even though they dominate the transcript", () => {
    expect(countHumanTurns([ASSISTANT, ASSISTANT, ASSISTANT, HUMAN])).toBe(1);
  });

  it("excludes a non-user entry even when it carries a human origin", () => {
    expect(countHumanTurns([HUMAN_WRONG_TYPE, HUMAN])).toBe(1);
  });

  it("returns 0 for a transcript predating the origin field", () => {
    // The accepted degradation: turn-counter.ts's `!count || count < 1` guard
    // then renders nothing, which beats rendering a wrong number.
    expect(countHumanTurns([{ type: "user" }, { type: "assistant" }])).toBe(0);
  });

  it("returns 0 for an empty transcript", () => {
    expect(countHumanTurns([])).toBe(0);
  });
});
