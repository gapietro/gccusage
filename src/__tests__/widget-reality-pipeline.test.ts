import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import { StatusJsonSchema } from "../types/status-json.js";
import { contextFromFixture } from "./fixtures/context-from-fixture.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: async () => ({}),
  // stale: false keeps the pipeline from spawning a real detached refresher
  // child during the suite.
  getPricingForRender: () => ({ pricing: {}, stale: false }),
}));

let tmpHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-realpipe-"));
  process.env["HOME"] = tmpHome;
  process.env["XDG_CACHE_HOME"] = path.join(tmpHome, "cache");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("real payload through the real pipeline", () => {
  it("produces a RenderContext with the same shape the matrix assumes", async () => {
    const fx = midFixture as unknown as RealPayloadFixture;
    const { buildRenderContext } = await import("../data/pipeline.js");
    const { DEFAULT_SETTINGS } = await import("../config/defaults.js");

    const stdin = v.parse(StatusJsonSchema, fx.stdin);
    const ctx = await buildRenderContext(stdin, DEFAULT_SETTINGS);

    // Every key the matrix's contextFromFixture reconstructs must exist on the
    // real context — derived from the helper itself, not a hand-copied list,
    // so this test cannot drift from what the matrix actually builds.
    const reconstructed = contextFromFixture(fx, tmpHome);
    for (const key of Object.keys(reconstructed)) {
      expect(ctx, `pipeline context is missing ${key}`).toHaveProperty(key);
    }
    expect(ctx.metrics.totals).toHaveProperty("inputTokens");
    expect(ctx.metrics.totals).toHaveProperty("cacheReadTokens");
    expect(ctx.costByModel).toBeInstanceOf(Map);
    // No transcripts exist under the tmp HOME, so session metrics are zero here.
    // The assertion is about SHAPE; the recorded fixture supplies the values.
    expect(typeof ctx.sessionCostUsd).toBe("number");
  }, 30000);
});
