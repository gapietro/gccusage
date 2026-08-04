import { describe, it, expect } from "vitest";
import { aggregateTokens, getFirstTimestamp } from "../data/token-aggregator.js";
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
