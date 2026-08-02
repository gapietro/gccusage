import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { StatusJson } from "../types/status-json.js";

// Pricing normally comes from the network; pin it so calculated costs are
// exact. Everything else (transcripts, the daily cost store) runs for real
// against a temp HOME/cache.
const PINNED_PRICING = {
  "test-model": {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheReadCostPerToken: 0,
  },
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  // stale: false on purpose — a true here would have the pipeline spawn a
  // real detached refresher child on every case in this file.
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

// One transcript entry worth exactly $1.00 of calculated cost.
const CALCULATED_COST = 1.0;

function shardDir(): string {
  return path.join(tmpDir, "gccusage", "daily");
}

function shardPath(sessionId: string): string {
  return path.join(shardDir(), `${sessionId}.json`);
}

function readShard(sessionId: string): unknown {
  return JSON.parse(fs.readFileSync(shardPath(sessionId), "utf-8"));
}

// The tracker keys its file on the local date, not UTC.
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function writeTranscript(sessionId: string): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        model: "test-model",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    }) + "\n",
  );
}

// A realistic multi-content-block transcript: each API response is written as
// one line per content block, all sharing a `message.id`, with `output_tokens`
// growing as the response streams. Only the final line of each group is the
// true usage for that response.
function writeMultiBlockTranscript(sessionId: string): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const line = (
    id: string,
    input: number,
    cacheRead: number,
    output: number,
    block: string,
  ): string =>
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        id,
        model: "test-model",
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
        },
        content: [{ type: block }],
      },
    });

  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    [
      line("msg_01", 100, 1000, 5, "thinking"),
      line("msg_01", 100, 1000, 107, "text"),
      line("msg_01", 100, 1000, 296, "tool_use"),
      line("msg_02", 200, 2000, 12, "thinking"),
      line("msg_02", 200, 2000, 340, "text"),
      line("msg_02", 200, 2000, 981, "tool_use"),
    ].join("\n") + "\n",
  );
}

function settingsWith(costSource: Settings["costSource"]): Settings {
  return { ...DEFAULT_SETTINGS, costSource };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-pipeline-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpDir;
  process.env["XDG_CACHE_HOME"] = tmpDir;
  writeTranscript("session-a");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildRenderContext today cost", () => {
  it("reports the JSONL-calculated total in calculated mode", async () => {
    const stdin: StatusJson = {
      session_id: "session-a",
      cost: { total_cost_usd: 7.0 },
    };

    const context = await buildRenderContext(stdin, settingsWith("calculated"));

    expect(context.todayCostUsd).toBeCloseTo(CALCULATED_COST);
  });

  it("does not create the daily cost store in calculated mode", async () => {
    const stdin: StatusJson = {
      session_id: "session-a",
      cost: { total_cost_usd: 7.0 },
    };

    await buildRenderContext(stdin, settingsWith("calculated"));

    expect(fs.existsSync(shardDir())).toBe(false);
  });

  it("leaves an existing daily cost store untouched in calculated mode", async () => {
    fs.mkdirSync(shardDir(), { recursive: true });
    const seeded = {
      sessionId: "session-b",
      date: localToday(),
      costUsd: 4.0,
      baselineUsd: 0,
      source: "stdin",
      updatedAt: Date.now(),
    };
    fs.writeFileSync(shardPath("session-b"), JSON.stringify(seeded));

    await buildRenderContext(
      { session_id: "session-a", cost: { total_cost_usd: 7.0 } },
      settingsWith("calculated"),
    );

    expect(readShard("session-b")).toEqual(seeded);
    expect(fs.readdirSync(shardDir())).toEqual(["session-b.json"]);
  });

  it("tracks stdin cost in the daily store when stdin costs are used", async () => {
    const context = await buildRenderContext(
      { session_id: "session-a", cost: { total_cost_usd: 3.0 } },
      settingsWith("auto"),
    );

    expect(context.todayCostUsd).toBeCloseTo(3.0);
    expect(readShard("session-a")).toMatchObject({
      sessionId: "session-a",
      costUsd: 3.0,
      source: "stdin",
    });
  });

  it("tracks the calculated fallback when auto mode finds no stdin cost", async () => {
    const context = await buildRenderContext(
      { session_id: "session-a" },
      settingsWith("auto"),
    );

    expect(context.todayCostUsd).toBeCloseTo(CALCULATED_COST);
    expect(readShard("session-a")).toMatchObject({
      sessionId: "session-a",
      costUsd: CALCULATED_COST,
      source: "calculated",
    });
  });
});

describe("buildRenderContext token totals from a multi-block transcript", () => {
  // Six lines, two responses. Per-line sums would be 900 input / 1741 output;
  // keeping each group's first line would give 300 input / 17 output. The
  // right answer is the sum of each group's *final* line.
  const EXPECTED_INPUT = 100 + 200;
  const EXPECTED_OUTPUT = 296 + 981;
  const EXPECTED_CACHE_READ = 1000 + 2000;

  it("counts each response once, using its last line's usage", async () => {
    writeMultiBlockTranscript("session-blocks");

    const context = await buildRenderContext(
      { session_id: "session-blocks" },
      settingsWith("calculated"),
    );

    expect(context.metrics.session).toEqual({
      inputTokens: EXPECTED_INPUT,
      outputTokens: EXPECTED_OUTPUT,
      cacheCreationTokens: 0,
      cacheReadTokens: EXPECTED_CACHE_READ,
    });

    // Guard the two wrong rules explicitly.
    expect(context.metrics.session.outputTokens).not.toBe(5 + 107 + 296 + 12 + 340 + 981);
    expect(context.metrics.session.outputTokens).not.toBe(5 + 12);

    expect(context.metrics.byModel.get("test-model")).toEqual({
      inputTokens: EXPECTED_INPUT,
      outputTokens: EXPECTED_OUTPUT,
      cacheCreationTokens: 0,
      cacheReadTokens: EXPECTED_CACHE_READ,
    });
  });
});

/**
 * One priced response, started an hour ago, so the JSONL burn-rate producer
 * clears its 10-second floor and yields a real rate. 1,000,000 input tokens at
 * $1/1M is $1.00 over ~1 hour, which is far enough from the stdin rate these
 * tests supply ($999/hr) that the two sources cannot be confused.
 */
function writeBackdatedTranscript(sessionId: string): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
      sessionId,
      message: {
        id: "msg_01",
        model: "test-model",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    }) + "\n",
  );
}

describe("burn rate cost source", () => {
  const STDIN_COST = { total_cost_usd: 999, total_duration_ms: 3_600_000 };

  it("uses the JSONL rate in calculated mode even when stdin carries a cost", async () => {
    // The bug: session-cost honoured costSource while burn-rate always preferred
    // stdin, so the bar showed a stdin-priced rate beside a JSONL-priced total.
    writeBackdatedTranscript("session-calc");

    const context = await buildRenderContext(
      { session_id: "session-calc", model: "test-model", cost: STDIN_COST },
      settingsWith("calculated"),
    );

    // Asserted positively: a null burn rate would fail this, where a
    // `not.toBe(999)` check would pass vacuously.
    expect(context.burnRate).not.toBeNull();
    expect(context.burnRate!.costPerHour).toBeCloseTo(1, 1);
  });

  it("prefers the stdin rate when the session total came from stdin", async () => {
    writeBackdatedTranscript("session-stdin");

    const context = await buildRenderContext(
      { session_id: "session-stdin", model: "test-model", cost: STDIN_COST },
      settingsWith("stdin"),
    );

    expect(context.burnRate).not.toBeNull();
    expect(context.burnRate!.costPerHour).toBeCloseTo(999, 6);
  });
});

// A transcript from a model the pricing table has never heard of — what a
// session looks like the day a new model ships, or on any offline render
// before #82 was fixed.
function writeUnpricedTranscript(sessionId: string): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        model: "claude-unpriced-9",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    }) + "\n",
  );
}

describe("unpriced models", () => {
  it("marks a calculated session cost uncertain", async () => {
    writeUnpricedTranscript("session-unpriced");

    const context = await buildRenderContext(
      { session_id: "session-unpriced" },
      settingsWith("calculated"),
    );

    expect(context.unpricedModels).toEqual(["claude-unpriced-9"]);
    expect(context.sessionCostUncertain).toBe(true);
    expect(context.todayCostUncertain).toBe(true);
  });

  it("leaves a fully priced calculated session certain", async () => {
    const context = await buildRenderContext(
      { session_id: "session-a" },
      settingsWith("calculated"),
    );

    expect(context.unpricedModels).toEqual([]);
    expect(context.sessionCostUncertain).toBe(false);
    expect(context.todayCostUncertain).toBe(false);
  });

  it("leaves a stdin-sourced cost certain even when a model is unpriced", async () => {
    // The displayed figure came from cost.total_cost_usd, not the pricing
    // table, so a missing price cannot have understated it. Marking it would
    // be a false alarm.
    writeUnpricedTranscript("session-unpriced-stdin");

    const context = await buildRenderContext(
      { session_id: "session-unpriced-stdin", cost: { total_cost_usd: 4.2 } },
      settingsWith("stdin"),
    );

    expect(context.sessionCostUsd).toBe(4.2);
    expect(context.sessionCostUncertain).toBe(false);
    expect(context.todayCostUncertain).toBe(false);
    // Still reported, because per-model-breakdown renders from the table.
    expect(context.unpricedModels).toEqual(["claude-unpriced-9"]);
  });

  it("marks auto mode uncertain when stdin carries no cost to fall back on", async () => {
    writeUnpricedTranscript("session-unpriced-auto");

    const context = await buildRenderContext(
      { session_id: "session-unpriced-auto" },
      settingsWith("auto"),
    );

    expect(context.sessionCostUncertain).toBe(true);
  });
});
