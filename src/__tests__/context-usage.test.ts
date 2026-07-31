import { describe, it, expect } from "vitest";
import { deriveContextUsage } from "../utils/context-usage.js";

describe("deriveContextUsage", () => {
  it("prefers remaining_percentage", () => {
    const usage = deriveContextUsage({
      context_window: { remaining_percentage: 93, context_window_size: 1_000_000 },
    });
    expect(usage).toEqual({ ratio: 0.07, windowSize: 1_000_000, usedTokens: 70_000 });
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
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000, usedTokens: 50_000 });
  });

  it("remaining_percentage beats used_percentage when both are present", () => {
    // When both fields exist, the higher-priority remaining_percentage must win
    const usage = deriveContextUsage({
      context_window: {
        remaining_percentage: 93,
        used_percentage: 50,
        context_window_size: 1_000_000,
      },
    });
    expect(usage).toEqual({ ratio: 0.07, windowSize: 1_000_000, usedTokens: 70_000 });
  });

  it("returns a null windowSize when the size is absent", () => {
    const usage = deriveContextUsage({ context_window: { used_percentage: 25 } });
    expect(usage).toEqual({ ratio: 0.25, windowSize: null, usedTokens: null });
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
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000, usedTokens: 50_000 });
  });

  it("used_percentage beats current_usage when both are present", () => {
    // When both fields exist, the higher-priority used_percentage must win
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
    // used_percentage (25) yields ratio 0.25, whereas current_usage would yield 0.5
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000, usedTokens: 100_000 });
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
    expect(usage).toEqual({ ratio: 0.25, windowSize: 200_000, usedTokens: 50_000 });
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
});
