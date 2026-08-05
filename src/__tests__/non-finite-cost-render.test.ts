import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStatusline } from "../statusline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
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
