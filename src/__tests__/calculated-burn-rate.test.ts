import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { burnRateWidget } from "../widgets/burn-rate.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { RenderContext } from "../types/render-context.js";
import type { StatusJson } from "../types/status-json.js";
import { stripAnsi } from "../utils/terminal.js";
import {
  reserveRefusedUrl,
  suppressPricingRefresh,
  type RefresherSuppression,
} from "./helpers/pricing-refresher.js";
import { isolatedEnv } from "./helpers/isolated-env.js";

/**
 * COR-008: the calculated burn rate priced ALL session tokens at the CURRENT
 * model's rate. A session of 400k opus and 1.6M haiku input tokens over one
 * hour showed $10.00/hr with opus selected and $2.00/hr with haiku, while the
 * per-model session total beside it read $3.60. It also never carried the `?`
 * that total carries when a model is unpriced or approximated.
 *
 * The rates are the offline snapshot's for these two ids, so the unit and
 * bundle tests below agree on the same arithmetic.
 */
const RATES = {
  "claude-opus-4-6": 5 / 1_000_000,
  "claude-haiku-4-5": 1 / 1_000_000,
};

function rateSet(input: number) {
  return {
    inputCostPerToken: input,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheCreation1hCostPerToken: 0,
    cacheReadCostPerToken: 0,
  };
}

const PINNED_PRICING = {
  "claude-opus-4-6": rateSet(RATES["claude-opus-4-6"]),
  "claude-haiku-4-5": rateSet(RATES["claude-haiku-4-5"]),
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  // stale: false, or the pipeline would spawn a real detached refresher.
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));

const SESSION = "0c080008-aaaa-4bbb-8ccc-000000000008";
const HOUR_MS = 3_600_000;

interface Turn {
  model: string;
  input: number;
}

/**
 * $2.00 of opus (4 × 100k) + $1.60 of haiku (10 × 160k) = $3.60, over one
 * hour. Every prompt is under the 200k premium threshold, so nothing is
 * approximated and the total is certain.
 */
const MIXED: Turn[] = [
  ...Array.from({ length: 4 }, () => ({ model: "claude-opus-4-6", input: 100_000 })),
  ...Array.from({ length: 10 }, () => ({ model: "claude-haiku-4-5", input: 160_000 })),
];
const MIXED_TOTAL = 3.6;

/**
 * Turns spread over the hour before now, each its own response. Every prompt
 * stays under the 200k premium threshold unless a test means to cross it.
 */
function transcriptLines(turns: Turn[]): string {
  const start = Date.now() - HOUR_MS;
  return (
    turns
      .map((t, i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(start + i * 1000).toISOString(),
          sessionId: SESSION,
          message: {
            id: `msg_${i}`,
            model: t.model,
            usage: { input_tokens: t.input, output_tokens: 0 },
          },
        }),
      )
      .join("\n") + "\n"
  );
}

function writeTranscript(home: string, turns: Turn[]): void {
  const projectDir = path.join(home, ".claude", "projects", "-proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), transcriptLines(turns));
}

function settingsWith(costSource: Settings["costSource"]): Settings {
  return { ...DEFAULT_SETTINGS, costSource };
}

describe("the calculated burn rate (COR-008)", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cor008-"));
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

  async function contextFor(
    model: StatusJson["model"],
    costSource: Settings["costSource"] = "calculated",
    cost?: StatusJson["cost"],
  ): Promise<RenderContext> {
    const stdin: StatusJson = { session_id: SESSION, model };
    if (cost) stdin.cost = cost;
    return buildRenderContext(stdin, settingsWith(costSource));
  }

  it.each([
    ["opus", "claude-opus-4-6"],
    ["haiku", "claude-haiku-4-5"],
    ["an unpriced model", "claude-unknown-9"],
    ["no model", undefined],
  ])("is the per-model session cost over elapsed time with %s current", async (_, model) => {
    writeTranscript(tmpDir, MIXED);

    const ctx = await contextFor(model);

    // Pre-fix: $10.00/hr with opus, $2.00/hr with haiku, and no segment at
    // all with an unpriced or missing current model.
    expect(ctx.sessionCostUsd).toBeCloseTo(MIXED_TOTAL, 10);
    expect(ctx.burnRate).not.toBeNull();
    expect(ctx.burnRate!.costPerHour).toBeCloseTo(MIXED_TOTAL, 2);
    expect(ctx.burnRate!.costPerMinute).toBeCloseTo(MIXED_TOTAL / 60, 4);
    expect(ctx.burnRateUncertain).toBe(false);
  });

  it("marks the rate uncertain when a transcript model is unpriced", async () => {
    writeTranscript(tmpDir, [...MIXED, { model: "claude-unknown-9", input: 1_000_000 }]);

    const ctx = await contextFor("claude-opus-4-6");

    // The priced part is kept, as the session total keeps it.
    expect(ctx.sessionCostUncertain).toBe(true);
    expect(ctx.burnRate!.costPerHour).toBeCloseTo(MIXED_TOTAL, 2);
    expect(ctx.burnRateUncertain).toBe(true);
  });

  it("marks the rate uncertain when a model is only approximated", async () => {
    // A 300k prompt on a price list with no premium tier (#103).
    writeTranscript(tmpDir, [{ model: "claude-opus-4-6", input: 300_000 }]);

    const ctx = await contextFor("claude-opus-4-6");

    expect(ctx.approximatedModels).toEqual(["claude-opus-4-6"]);
    expect(ctx.burnRate!.costPerHour).toBeCloseTo(1.5, 2);
    expect(ctx.burnRateUncertain).toBe(true);
  });

  it("shows no rate when nothing in the session could be priced", async () => {
    // A $0.00/hr beside real token usage is a figure it cannot back. The
    // session total still renders "$0.00?", which already says so.
    writeTranscript(tmpDir, [{ model: "claude-unknown-9", input: 1_000_000 }]);

    const ctx = await contextFor("claude-opus-4-6");

    expect(ctx.burnRate).toBeNull();
    expect(ctx.burnRateUncertain).toBe(false);
  });

  it("is uncertain in auto mode when stdin has no cost and a model is unpriced", async () => {
    writeTranscript(tmpDir, [...MIXED, { model: "claude-unknown-9", input: 1 }]);

    const ctx = await contextFor("claude-opus-4-6", "auto");

    expect(ctx.burnRate!.costPerHour).toBeCloseTo(MIXED_TOTAL, 2);
    expect(ctx.burnRateUncertain).toBe(true);
  });

  it("never marks the stdin rate uncertain, whatever the transcript holds", async () => {
    writeTranscript(tmpDir, [...MIXED, { model: "claude-unknown-9", input: 1 }]);

    const ctx = await contextFor("claude-opus-4-6", "stdin", {
      total_cost_usd: 999,
      total_duration_ms: HOUR_MS,
    });

    expect(ctx.burnRate!.costPerHour).toBeCloseTo(999, 6);
    expect(ctx.burnRateUncertain).toBe(false);
  });

  it("marks the calculated fallback uncertain when stdin's duration is too short", async () => {
    // Stdin mode, but under 10s of stdin duration: the pipeline falls back to
    // the calculated rate. The session total is stdin-sourced, so the session
    // flag is false here, which is why the rate has its own flag.
    writeTranscript(tmpDir, [...MIXED, { model: "claude-unknown-9", input: 1 }]);

    const ctx = await contextFor("claude-opus-4-6", "stdin", {
      total_cost_usd: 999,
      total_duration_ms: 5_000,
    });

    expect(ctx.sessionCostUncertain).toBe(false);
    expect(ctx.burnRate!.costPerHour).toBeCloseTo(MIXED_TOTAL, 2);
    expect(ctx.burnRateUncertain).toBe(true);
  });
});

function widgetContext(overrides: Partial<RenderContext>): RenderContext {
  return {
    stdin: {},
    metrics: {
      byModel: new Map(),
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      },
    },
    block: null,
    burnRate: null,
    burnRateUncertain: false,
    pricing: {},
    sessionCostUsd: 0,
    todayCostUsd: 0,
    costByModel: new Map(),
    unpricedModels: [],
    approximatedModels: [],
    sessionCostUncertain: false,
    todayCostUncertain: false,
    sessionStartTime: null,
    terminalWidth: 120,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: 0,
    ...overrides,
  };
}

describe("burnRateWidget's uncertainty marker (COR-008)", () => {
  const render = (costPerHour: number, burnRateUncertain: boolean, label?: string) =>
    burnRateWidget.render(
      widgetContext({ burnRate: { costPerHour, costPerMinute: costPerHour / 60 }, burnRateUncertain }),
      label === undefined ? { type: "burn-rate" } : { type: "burn-rate", label },
    )!.text;

  it("appends ? to an uncertain rate", () => {
    expect(render(3.6, true)).toBe("$3.60/hr?");
  });

  it("appends ? after the label's amount too", () => {
    expect(render(3.6, true, "Burn:")).toBe("Burn: $3.60/hr?");
  });

  it("leaves a certain rate unmarked", () => {
    expect(render(3.6, false)).toBe("$3.60/hr");
  });

  it.each([Infinity, -Infinity, NaN])(
    "renders a non-finite rate %s as $?/hr without a second marker",
    (rate) => {
      // The same rule #145 applied to "$??": "$?/hr" already says unknown.
      expect(render(rate, true)).toBe("$?/hr");
    },
  );
});

/**
 * Through the shipped bundle, priced from the offline snapshot (the refresher
 * is suppressed and its URL refused). The two renders differ only in the
 * stdin model, so they also differ in the statusline cache key.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

describe.skipIf(!distExists)("the calculated burn rate through the real bundle (COR-008)", () => {
  const LAYOUT = {
    costSource: "calculated",
    lines: [{ widgets: [{ type: "session-cost" }, { type: "burn-rate" }] }],
  };

  let dir: string;
  let refusedPricingUrl: string;
  let refresher: RefresherSuppression;

  beforeAll(async () => {
    refusedPricingUrl = await reserveRefusedUrl();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cor008-bundle-"));
    const cacheHome = path.join(dir, "cache");
    fs.mkdirSync(path.join(cacheHome, "gccusage"), { recursive: true });
    refresher = suppressPricingRefresh(cacheHome, refusedPricingUrl);
    const configDir = path.join(dir, "config", "gccusage");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(LAYOUT));
  });

  afterEach(() => {
    refresher.assertNotSpawned();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function render(modelId: string): string {
    const out = execFileSync(process.execPath, [DIST], {
      // Outside any repo: a render must never run git in the checkout (#148).
      cwd: dir,
      input: JSON.stringify({ session_id: SESSION, model: { id: modelId, display_name: "M" } }),
      env: {
        ...isolatedEnv(dir),
        ...refresher.env,
        COLUMNS: "200",
      },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stripAnsi(out);
  }

  it("shows the same rate whichever model is current", () => {
    writeTranscript(dir, MIXED);

    const withOpus = render("claude-opus-4-6");
    const withHaiku = render("claude-haiku-4-5");

    // Pre-fix: "$10.00/hr" and "$2.00/hr".
    expect(withOpus).toContain("$3.60");
    expect(withOpus).toMatch(/\$3\.(59|60)\/hr(?!\?)/);
    expect(withHaiku).toMatch(/\$3\.(59|60)\/hr(?!\?)/);
  });

  it("marks the rate with ? when the session total is uncertain", () => {
    writeTranscript(dir, [...MIXED, { model: "claude-unknown-9", input: 1_000_000 }]);

    const out = render("claude-opus-4-6");

    expect(out).toContain("$3.60?");
    expect(out).toMatch(/\$3\.(59|60)\/hr\?/);
  });
});
