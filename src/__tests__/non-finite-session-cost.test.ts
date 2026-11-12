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
 * #145 through the shipped bundle. A non-finite calculated session cost used
 * to reach the daily store as `"costUsd": null`. `ShardSchema` rejects that on
 * the next read, so the session dropped out of every bar's `Today:` and lost
 * its baseline. The bar also rendered `$??`.
 *
 * Two routes to a non-finite cost, guarded at two different places:
 * - a token count `JSON.parse` overflows to `Infinity` (`1e400`): rejected at
 *   ingestion, so the cost stays finite;
 * - finite counts whose SUM overflows (two turns of 1.7e308 tokens): nothing
 *   at ingestion can see this, so the store-write guard has to hold the line.
 *   With real pricing these prompts also cross the 200k tier, where
 *   `Infinity - Infinity` makes the cost NaN rather than Infinity. Both are
 *   non-finite and every guard treats them alike; the unit tests in
 *   daily-cost-tracker.test.ts cover Infinity, -Infinity and NaN directly.
 *
 * Transcript lines are written as raw text: `JSON.stringify(Infinity)` is
 * `null`, so stringify would never feed the reader the bytes under test.
 * Each test gets a fresh HOME and renders once, so the statusline cache
 * cannot serve one test's bar to another.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

const SESSION_ID = "5e1f0a7b-2c3d-4e5f-9a8b-145145145145";
const OPUS = { id: "claude-opus-4-6", display_name: "Opus 4.6" };
const COST_LAYOUT = {
  lines: [{ widgets: [{ type: "model" }, { type: "session-cost" }, { type: "today-spend" }] }],
};

let dir: string;
let cacheHome: string;
let refusedPricingUrl: string;
let refresher: RefresherSuppression;

beforeAll(async () => {
  refusedPricingUrl = await reserveRefusedUrl();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-145-"));
  cacheHome = path.join(dir, "cache");
  fs.mkdirSync(path.join(cacheHome, "gccusage"), { recursive: true });
  refresher = suppressPricingRefresh(cacheHome, refusedPricingUrl);
  const configDir = path.join(dir, "config", "gccusage");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(COST_LAYOUT));
});

afterEach(() => {
  refresher.assertNotSpawned();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One assistant turn per usage object, given as raw JSON text. */
function writeTranscript(usages: string[]): void {
  const projectDir = path.join(dir, ".claude", "projects", "p");
  fs.mkdirSync(projectDir, { recursive: true });
  const start = Date.now() - 5 * 60_000;
  const lines = usages.map(
    (usage, i) =>
      `{"type":"assistant","timestamp":"${new Date(start + i * 1000).toISOString()}",` +
      `"message":{"id":"msg_${i}","model":"claude-opus-4-6","usage":${usage}}}`,
  );
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join("\n") + "\n");
}

function shardPath(): string {
  return path.join(cacheHome, "gccusage", "daily", `${SESSION_ID}.json`);
}

function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The last good render of this session, as the store would hold it. */
function seedShard(costUsd: number, baselineUsd: number): string {
  fs.mkdirSync(path.dirname(shardPath()), { recursive: true });
  const bytes = JSON.stringify({
    sessionId: SESSION_ID,
    date: localDate(new Date()),
    costUsd,
    baselineUsd,
    source: "calculated",
    updatedAt: Date.now() - 60_000,
  });
  fs.writeFileSync(shardPath(), bytes);
  return bytes;
}

function render(): string {
  // No stdin cost, so the session total is calculated from the transcript.
  const out = execFileSync(process.execPath, [DIST], {
    // Outside any repo: a render must never run git in the checkout (#148).
    cwd: dir,
    input: JSON.stringify({ session_id: SESSION_ID, model: OPUS }),
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

describe.skipIf(!distExists)("non-finite session cost through the real bundle (#145)", () => {
  it("prices around an overflowing token count instead of rendering $?", () => {
    writeTranscript([
      `{"input_tokens":1000,"output_tokens":1000}`,
      `{"input_tokens":1e400,"output_tokens":0}`,
    ]);
    const out = render();

    expect(out).not.toContain("$?");
    expect(out).toContain("Today: $0.03");
    // The bytes on disk, not a re-parsed value: the bug was a literal null.
    const raw = fs.readFileSync(shardPath(), "utf8");
    expect(raw).not.toContain("null");
    expect((JSON.parse(raw) as { costUsd: number }).costUsd).toBeCloseTo(0.03, 10);
  });

  it("leaves the shard byte-identical when the summed cost overflows", () => {
    const before = seedShard(0.5, 0.2);
    writeTranscript([
      `{"input_tokens":1.7e308,"output_tokens":0}`,
      `{"input_tokens":1.7e308,"output_tokens":0}`,
    ]);
    render();

    expect(fs.readFileSync(shardPath(), "utf8")).toBe(before);
  });

  it("renders one $? for the session and keeps its last good spend in Today:, marked", () => {
    seedShard(0.5, 0.2);
    writeTranscript([
      `{"input_tokens":1.7e308,"output_tokens":0}`,
      `{"input_tokens":1.7e308,"output_tokens":0}`,
    ]);
    const out = render();

    expect(out).not.toContain("$??");
    expect(out).toMatch(/\$\?(?!\?)/);
    // 0.50 - 0.20 accrued today, flagged because this render couldn't update it.
    expect(out).toContain("Today: $0.30?");
  });
});
