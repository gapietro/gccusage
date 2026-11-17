import { describe, it, expect } from "vitest";
import * as v from "valibot";
import {
  CLOCK_SKEW_ALLOWANCE_MS,
  ageSince,
  finiteNumber,
  persistedTimestamp,
} from "../utils/schemas.js";

/**
 * COR-006: the shared rules every persisted number goes through. The cache
 * tests (persisted-timestamps.test.ts) prove each consumer applies them; these
 * pin the rules themselves, which is the only place a schema-only regression
 * shows. Each consumer's future-stamp check also catches `1e400` (its age is
 * `-Infinity`), so reverting a schema to bare `v.number()` leaves the
 * per-cache `1e400` tests green — the overlap is deliberate defence in depth,
 * and it means the schema needs its own red test.
 *
 * Inputs come from `JSON.parse` of raw text, not literals, where the point is
 * what the parser produces: `JSON.stringify(Infinity)` is `null`, so a fixture
 * built through the writer never feeds the parser the bytes under test (#133).
 */
function parsed(raw: string): unknown {
  return (JSON.parse(`{"x":${raw}}`) as { x: unknown }).x;
}

describe("finiteNumber (COR-006)", () => {
  it.each(["1e400", "-1e400"])("rejects %s, which JSON.parse turns into an infinity", (raw) => {
    expect(v.is(finiteNumber(), parsed(raw))).toBe(false);
  });

  it("rejects NaN", () => {
    expect(v.is(finiteNumber(), Number.NaN)).toBe(false);
  });

  it("accepts an ordinary fractional number (control)", () => {
    expect(v.is(finiteNumber(), parsed("1.5"))).toBe(true);
  });
});

describe("persistedTimestamp (COR-006)", () => {
  it("rejects 1e400, which JSON.parse turns into Infinity", () => {
    expect(v.is(persistedTimestamp(), parsed("1e400"))).toBe(false);
  });

  it("rejects 1e300, which v.finite() alone would accept", () => {
    // The value that tells `safeInteger` apart from `finite`: `now - 1e300`
    // is as never-stale as `now - Infinity` (#130).
    expect(v.is(persistedTimestamp(), parsed("1e300"))).toBe(false);
  });

  it("rejects a fractional stamp, which Date.now() never writes", () => {
    expect(v.is(persistedTimestamp(), parsed("1.5"))).toBe(false);
  });

  it("accepts a real Date.now() stamp (control)", () => {
    expect(v.is(persistedTimestamp(), parsed(String(Date.now())))).toBe(true);
  });

  it("still accepts 9e15, a safe integer centuries in the future — the schema cannot judge time", () => {
    // Pinned so nobody mistakes the schema for the whole fix: this value
    // froze pricing in the COR-006 repro, and only `ageSince` rejects it.
    expect(v.is(persistedTimestamp(), parsed("9e15"))).toBe(true);
    expect(ageSince(9e15)).toBeNull();
  });
});

describe("ageSince (COR-006)", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it("returns the age of a stamp in the past", () => {
    expect(ageSince(NOW - 5000, NOW)).toBe(5000);
  });

  it("returns 0, not a negative age, for a stamp just inside the skew allowance", () => {
    // Clamped so a consumer can never compute a remaining time longer than
    // the whole window, e.g. a block with more than five hours left.
    expect(ageSince(NOW + CLOCK_SKEW_ALLOWANCE_MS, NOW)).toBe(0);
  });

  it("returns null for a stamp just past the skew allowance", () => {
    expect(ageSince(NOW + CLOCK_SKEW_ALLOWANCE_MS + 1, NOW)).toBeNull();
  });

  it("returns null for a stamp a day in the future, rather than reading it as fresh", () => {
    expect(ageSince(NOW + DAY, NOW)).toBeNull();
  });

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
    "returns null for %s",
    (stamp) => {
      expect(ageSince(stamp, NOW)).toBeNull();
    },
  );

  it("keeps the allowance well under the shortest TTL it gates (the 5 s statusline cache)", () => {
    // A stamp inside the allowance reads as age 0, so it can stretch a TTL by
    // at most this much. Larger than the 5 s statusline default, it would
    // stretch that cache past double its TTL.
    expect(CLOCK_SKEW_ALLOWANCE_MS).toBeLessThanOrEqual(1000);
  });
});
