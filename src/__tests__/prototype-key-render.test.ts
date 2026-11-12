import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripAnsi } from "../utils/terminal.js";
import {
  reserveRefusedUrl,
  suppressPricingRefresh,
  type RefresherSuppression,
} from "./helpers/pricing-refresher.js";

/**
 * #143 through the shipped bundle. Each test gets a fresh HOME and renders
 * once, so the 5s statusline cache can never serve one test's bar to another.
 *
 * Config (widget `type`, `powerline.theme`): a prototype-member name used to
 * throw inside the render, and `main().catch()` turned that into an EMPTY bar.
 *
 * Model ids (transcript `message.model`, stdin `model.id`): the bar survived,
 * but `findPricing` returned an inherited member as pricing, so the cost came
 * out NaN. Measured against the pre-fix bundle, the damage was wider than one
 * model's figure: the session total and Today both rendered `$?` (losing the
 * part that WAS priced), the burn rate rendered `$?/hr`, and the daily shard
 * was written with `"costUsd": null` — which `ShardSchema` rejects on the next
 * read, silently dropping the session from the store. Each assertion below is
 * one that differs between the pre-fix and fixed bundle.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

const PROTOTYPE_KEYS = ["constructor", "toString", "__proto__", "hasOwnProperty"];
const SESSION_ID = "1d4e0f7a-0b6c-4c43-9a8e-143143143143";

let dir: string;
let cacheHome: string;
let refusedPricingUrl: string;
let refresher: RefresherSuppression;

beforeAll(async () => {
  refusedPricingUrl = await reserveRefusedUrl();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-proto-"));
  cacheHome = path.join(dir, "cache");
  fs.mkdirSync(path.join(cacheHome, "gccusage"), { recursive: true });
  refresher = suppressPricingRefresh(cacheHome, refusedPricingUrl);
});

afterEach(() => {
  refresher.assertNotSpawned();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeSettings(settings: unknown): void {
  const configDir = path.join(dir, "config", "gccusage");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings));
}

/** One assistant turn per model, 1,000 input + 1,000 output tokens each. */
function writeTranscript(models: string[]): void {
  const projectDir = path.join(dir, ".claude", "projects", "p");
  fs.mkdirSync(projectDir, { recursive: true });
  const start = Date.now() - 5 * 60_000;
  const lines = models.map((model, i) =>
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(start + i * 1000).toISOString(),
      message: { id: `msg_${i}`, model, usage: { input_tokens: 1000, output_tokens: 1000 } },
    }),
  );
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join("\n") + "\n");
}

function render(stdin: Record<string, unknown>): string {
  const out = execFileSync(process.execPath, [DIST], {
    // Outside any repo: a render must never run git in the checkout (#148).
    cwd: dir,
    input: JSON.stringify({ session_id: SESSION_ID, ...stdin }),
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      ...refresher.env,
      COLUMNS: "200",
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return stripAnsi(out);
}

function shardCostUsd(): unknown {
  const shard = path.join(cacheHome, "gccusage", "daily", `${SESSION_ID}.json`);
  return (JSON.parse(fs.readFileSync(shard, "utf8")) as { costUsd: unknown }).costUsd;
}

const OPUS = { id: "claude-opus-4-6", display_name: "Opus 4.6" };
const PRICED = { model: OPUS, cost: { total_cost_usd: 7.5 } };

describe.skipIf(!distExists)("prototype-key config through the real bundle (#143)", () => {
  it.each([["nosuch"], ...PROTOTYPE_KEYS.map((k) => [k])])(
    "renders the bar with widget type %j skipped",
    (type) => {
      writeSettings({ lines: [{ widgets: [{ type: "model" }, { type }, { type: "session-cost" }] }] });
      const out = render(PRICED);
      expect(out).toContain("Opus 4.6");
      expect(out).toContain("$7.50");
    },
  );

  it.each([["nosuch"], ...PROTOTYPE_KEYS.map((k) => [k])])(
    "renders the bar with powerline theme %j falling back to default",
    (theme) => {
      writeSettings({
        powerline: { enabled: true, theme },
        lines: [{ widgets: [{ type: "model" }, { type: "session-cost" }] }],
      });
      const out = render(PRICED);
      expect(out).toContain("Opus 4.6");
      expect(out).toContain("$7.50");
    },
  );
});

describe.skipIf(!distExists)("prototype-key model ids through the real bundle (#143)", () => {
  // No stdin cost, so the session total is calculated from the transcript.
  const COST_LAYOUT = {
    lines: [
      {
        widgets: [
          { type: "model" },
          { type: "session-cost" },
          { type: "today-spend" },
          { type: "burn-rate" },
        ],
      },
    ],
  };

  it("prices an opus-only transcript (control)", () => {
    writeSettings(COST_LAYOUT);
    writeTranscript(["claude-opus-4-6"]);
    const out = render({ model: OPUS });
    expect(out).toContain("$0.03");
    expect(out).not.toContain("$0.03?");
    expect(out).toContain("Today: $0.03");
    expect(shardCostUsd()).toBeCloseTo(0.03, 10);
  });

  it.each(PROTOTYPE_KEYS)(
    "treats transcript model %j as unpriced: priced part kept, marked uncertain, shard finite",
    (model) => {
      writeSettings(COST_LAYOUT);
      writeTranscript(["claude-opus-4-6", model]);
      const out = render({ model: OPUS });
      // The same rendering an ordinary unknown model gets: a lower bound with
      // the uncertainty marker, not "$?" for the whole session.
      expect(out).toContain("$0.03?");
      // Deliberately silent on a `?` after Today: in store mode Today is not
      // marked uncertain for ANY unpriced model, which predates #143. Pre-fix
      // this read "Today: $?", so the assertion still discriminates.
      expect(out).toContain("Today: $0.03");
      expect(shardCostUsd()).toBeCloseTo(0.03, 10);
    },
  );

  it("shows a burn rate for a priced stdin model (control)", () => {
    writeSettings(COST_LAYOUT);
    writeTranscript(["claude-opus-4-6"]);
    expect(render({ model: OPUS })).toContain("/hr");
  });

  it.each(PROTOTYPE_KEYS)("drops the burn-rate segment for stdin model id %j", (id) => {
    writeSettings(COST_LAYOUT);
    writeTranscript(["claude-opus-4-6"]);
    const out = render({ model: { id, display_name: "X" } });
    // calculateBurnRate's contract for an unpriced model: no segment rather
    // than a figure it cannot back. Pre-fix this rendered "$?/hr".
    expect(out).not.toContain("/hr");
    expect(out).toContain("$0.03");
  });
});
