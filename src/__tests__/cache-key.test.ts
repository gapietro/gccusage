import { describe, it, expect } from "vitest";
import { computeCacheKey } from "../cache/cache-key.js";
import type { StatusJson } from "../types/status-json.js";

const stdin = (extra: Partial<StatusJson> = {}): StatusJson => ({
  session_id: "session-a",
  cost: { total_cost_usd: 1.25 },
  ...extra,
});

describe("computeCacheKey", () => {
  it("gives equal payloads the same key", () => {
    expect(computeCacheKey(stdin(), 120)).toBe(computeCacheKey(stdin(), 120));
  });

  it("ignores property order", () => {
    const a = computeCacheKey(
      { session_id: "s", cwd: "/tmp", cost: { total_cost_usd: 1 } },
      120,
    );
    const b = computeCacheKey(
      { cost: { total_cost_usd: 1 }, cwd: "/tmp", session_id: "s" },
      120,
    );

    expect(a).toBe(b);
  });

  it("treats an explicitly undefined field as an absent one", () => {
    expect(computeCacheKey({ session_id: "s", vim: undefined }, 120)).toBe(
      computeCacheKey({ session_id: "s" }, 120),
    );
  });

  // Fresh spend must reach the daily accounting in the full pipeline, so a
  // changed cumulative cost has to miss (issue #30).
  it("changes when the cumulative cost changes", () => {
    expect(computeCacheKey(stdin({ cost: { total_cost_usd: 2.5 } }), 120)).not.toBe(
      computeCacheKey(stdin(), 120),
    );
  });

  it("changes when the session changes", () => {
    expect(computeCacheKey(stdin({ session_id: "session-b" }), 120)).not.toBe(
      computeCacheKey(stdin(), 120),
    );
  });

  // Layout depends on width, so a bar cached at another width is wrong
  // output rather than stale output (PR #71).
  it("changes when the terminal width changes", () => {
    expect(computeCacheKey(stdin(), 60)).not.toBe(computeCacheKey(stdin(), 120));
  });

  it("distinguishes an unknown terminal width from a known one", () => {
    expect(computeCacheKey(stdin(), undefined)).not.toBe(computeCacheKey(stdin(), 120));
  });

  it("changes when the model changes", () => {
    expect(
      computeCacheKey(stdin({ model: { id: "claude-opus-5", display_name: "Opus 5" } }), 120),
    ).not.toBe(
      computeCacheKey(stdin({ model: { id: "claude-sonnet-5", display_name: "Sonnet 5" } }), 120),
    );
  });

  // The deliberate exclusion: these tick on every spawn, so keying on them
  // would miss every render and re-read the whole transcript set (#94).
  it("ignores the session duration counters", () => {
    const early = computeCacheKey(
      stdin({ cost: { total_cost_usd: 1.25, total_duration_ms: 60000, total_api_duration_ms: 9000 } }),
      120,
    );
    const later = computeCacheKey(
      stdin({ cost: { total_cost_usd: 1.25, total_duration_ms: 61000, total_api_duration_ms: 9400 } }),
      120,
    );

    expect(later).toBe(early);
  });

  it("does not mutate the payload it hashes", () => {
    const payload = stdin({
      cost: { total_cost_usd: 1.25, total_duration_ms: 60000 },
    });

    computeCacheKey(payload, 120);

    expect(payload.cost?.total_duration_ms).toBe(60000);
  });
});
