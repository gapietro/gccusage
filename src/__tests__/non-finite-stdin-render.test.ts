import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStatusline } from "../statusline.js";
import { parseStatusJson } from "../data/stdin-reader.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { formatTokens, formatDuration } from "../utils/format.js";
import { stripAnsi } from "../utils/terminal.js";
import type { StatusJson } from "../types/status-json.js";

// Pricing normally comes from the network; keep it out of this test entirely
// (the point here is stdin-sourced cost, which never touches the pricing
// table at all).
vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({})),
  getPricingForRender: vi.fn(() => ({ pricing: {}, stale: false })),
}));

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-nonfinite-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpDir;
  process.env["XDG_CACHE_HOME"] = path.join(tmpDir, "cache");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The reachable-from-stdin regression for #131: `JSON.parse("1e400")` is
// `Infinity`, and it never passes through any schema that would reject it on
// the render path — #130 constrained only the daily-cost SHARD, which
// `trackDailyCost` never reads on the way to computing today's figure in
// memory. Drives the REAL pipeline end to end (buildRenderContext +
// renderStatusline, not mocked) through the DEFAULT layout, because a
// shard-based test would pass without the fix and prove nothing about this
// path.
describe("non-finite stdin cost does not put \"Infinity\" on the bar (#131)", () => {
  it("renders no literal Infinity for session-cost, burn-rate, or today-spend", async () => {
    const stdin: StatusJson = {
      session_id: "session-nonfinite",
      model: { id: "claude-opus-4-5", display_name: "Opus" },
      // total_duration_ms >= 10s is required for burn-rate to compute a rate
      // from stdin (see getStdinBurnRate in pipeline.ts) rather than render
      // nothing.
      // 1e400 overflowing to Infinity is exactly what this test exercises, so
      // the precision loss is deliberate and must not be "fixed".
      // oxlint-disable-next-line no-loss-of-precision
      cost: { total_cost_usd: 1e400, total_duration_ms: 3_600_000 },
    };

    const output = await runStatusline(stdin, DEFAULT_SETTINGS);

    expect(output).not.toContain("Infinity");
    // Positive check, not just an absence check: the uncertainty marker
    // actually appears, so this cannot pass by the widgets silently going
    // dark instead of rendering the (guarded) value.
    expect(output).toContain("$?");
  });
});

/**
 * #137. The same class on a different axis: the STDIN SCHEMA, not a formatter.
 *
 * These drive `parseStatusJson` first, the way `index.ts` does — the test
 * above hands `runStatusline` an object literal, which bypasses
 * `StatusJsonSchema` entirely and therefore cannot exercise a schema fix at
 * all. That difference is the whole reason #131 was closed in the formatter
 * and this axis stayed open: `v.number()` accepts `Infinity`, because
 * `JSON.parse('{"x":1e400}')` overflows to it even though JSON has no
 * `Infinity` literal.
 *
 * Seeded as raw JSON text on purpose. That is what stdin actually is, and
 * `JSON.stringify({ x: Infinity })` would emit `{"x":null}` and prove nothing.
 */
describe("non-finite stdin numbers survive the schema (#137)", () => {
  it("keeps Infinity out of the context-percent widget's window size", async () => {
    const { stdin } = parseStatusJson(`{
      "session_id": "session-window",
      "model": { "id": "claude-opus-4-5", "display_name": "Opus" },
      "context_window": {
        "context_window_size": 1e400,
        "used_percentage": 42,
        "current_usage": { "input_tokens": 10, "output_tokens": 5 }
      }
    }`);

    const output = await runStatusline(stdin!, DEFAULT_SETTINGS);

    // Rendered `[====------] 42% (InfinityM)` before the fix: an infinite
    // window size passes `windowSize && windowSize > 0` and reaches
    // `formatTokens`, where `(Infinity / 1e6).toFixed(2)` is the text
    // "Infinity".
    expect(output).not.toContain("Infinity");
    // Positive check: the percentage still renders. A rejected window size
    // must cost the window size only — `lenient` turns it into undefined and
    // `deriveContextUsage` already handles a null one — not the widget.
    expect(output).toContain("42%");
    // And the discriminating one. Absent `not.toMatch`, this test passes with
    // the SCHEMA FIX REVERTED, because the `formatTokens` guard alone turns
    // `(InfinityM)` into `(?)` and satisfies the two assertions above —
    // verified by reverting it, per the standing rule in [[vacuous-tests]].
    // A discarded field must render as nothing, not as an uncertainty marker:
    // there is no uncertainty about the percentage, and `(?)` would claim the
    // window size is known-but-unstateable when it was simply thrown away.
    // The healthy control for this shape is `42% (200.0k)`.
    expect(stripAnsi(output)).not.toMatch(/42%\s*\(/);
  });

  it("keeps Infinity out of the lines-changed widget", async () => {
    const { stdin } = parseStatusJson(`{
      "session_id": "session-lines",
      "model": { "id": "claude-opus-4-5", "display_name": "Opus" },
      "cost": {
        "total_cost_usd": 1,
        "total_lines_added": 1e400,
        "total_lines_removed": 2
      }
    }`);

    const output = await runStatusline(stdin!, DEFAULT_SETTINGS);

    expect(output).not.toContain("Infinity"); // was `+Infinity -2`
    // The sibling count survives, so this cannot pass by the widget going
    // dark: with both counts gone `linesChangedWidget` returns null.
    expect(output).toContain("-2");
  });
});

/**
 * Defence in depth for the two formatters that never got the guard
 * `formatDollars` and `formatCostPerHour` have. Not redundant with the schema
 * fix: token counts also arrive from JSONL transcripts via `jsonl-reader`,
 * whose own `typeof x === "number"` guards never touch `StatusJsonSchema`.
 */
describe("formatters render a marker rather than the text \"Infinity\" (#137)", () => {
  it("formatTokens does not stringify a non-finite count", () => {
    expect(formatTokens(Infinity)).not.toContain("Infinity");
    expect(formatTokens(Infinity)).toBe("?");
    expect(formatTokens(Number.NaN)).toBe("?");
    // The finite path is untouched.
    expect(formatTokens(1_500_000)).toBe("1.50M");
  });

  it("formatDuration does not stringify a non-finite span", () => {
    // `Math.floor(Infinity)` is `Infinity`, so this produced the particularly
    // bad "Infinityhr NaNm" — two broken numbers from one bad input.
    expect(formatDuration(Infinity)).toBe("?");
    expect(formatDuration(Number.NaN)).toBe("?");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});
