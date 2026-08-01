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
vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({
    "test-model": {
      inputCostPerToken: 1 / 1_000_000,
      outputCostPerToken: 0,
      cacheCreationCostPerToken: 0,
      cacheReadCostPerToken: 0,
    },
  })),
}));

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

// One transcript entry worth exactly $1.00 of calculated cost.
const CALCULATED_COST = 1.0;

function dailyCostPath(): string {
  return path.join(tmpDir, "gccusage", "daily-costs.json");
}

function readStore(): unknown {
  return JSON.parse(fs.readFileSync(dailyCostPath(), "utf-8"));
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

    expect(fs.existsSync(dailyCostPath())).toBe(false);
  });

  it("leaves an existing daily cost store untouched in calculated mode", async () => {
    fs.mkdirSync(path.dirname(dailyCostPath()), { recursive: true });
    const seeded = {
      date: localToday(),
      sessions: [
        {
          sessionId: "session-b",
          costUsd: 4.0,
          baselineUsd: 0,
          source: "stdin",
          updatedAt: Date.now(),
        },
      ],
    };
    fs.writeFileSync(dailyCostPath(), JSON.stringify(seeded));

    await buildRenderContext(
      { session_id: "session-a", cost: { total_cost_usd: 7.0 } },
      settingsWith("calculated"),
    );

    expect(readStore()).toEqual(seeded);
  });

  it("tracks stdin cost in the daily store when stdin costs are used", async () => {
    const context = await buildRenderContext(
      { session_id: "session-a", cost: { total_cost_usd: 3.0 } },
      settingsWith("auto"),
    );

    expect(context.todayCostUsd).toBeCloseTo(3.0);
    expect(readStore()).toMatchObject({
      sessions: [{ sessionId: "session-a", costUsd: 3.0, source: "stdin" }],
    });
  });

  it("tracks the calculated fallback when auto mode finds no stdin cost", async () => {
    const context = await buildRenderContext(
      { session_id: "session-a" },
      settingsWith("auto"),
    );

    expect(context.todayCostUsd).toBeCloseTo(CALCULATED_COST);
    expect(readStore()).toMatchObject({
      sessions: [
        { sessionId: "session-a", costUsd: CALCULATED_COST, source: "calculated" },
      ],
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
