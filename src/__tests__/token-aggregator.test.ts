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

  it("aggregates session totals", () => {
    const result = aggregateTokens(entries, []);
    expect(result.session.inputTokens).toBe(8000);
    expect(result.session.outputTokens).toBe(3300);
  });

  it("aggregates by model", () => {
    const result = aggregateTokens(entries, []);
    expect(result.byModel.size).toBe(2);
    expect(result.byModel.get("claude-sonnet-4-20250514")?.inputTokens).toBe(3000);
    expect(result.byModel.get("claude-opus-4-20250514")?.inputTokens).toBe(5000);
  });

  it("aggregates today's totals separately", () => {
    const todayEntries: JsonlEntry[] = [
      { usage: { input_tokens: 100, output_tokens: 50 } },
    ];
    const result = aggregateTokens([], todayEntries);
    expect(result.today.inputTokens).toBe(100);
    expect(result.session.inputTokens).toBe(0);
  });
});

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
