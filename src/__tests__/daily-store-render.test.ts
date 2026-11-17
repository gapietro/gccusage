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
 * The daily store's audit findings (2026-11-16) through the shipped bundle,
 * where the process identity comes from the real payload's
 * `cost.total_duration_ms` rather than from a test argument.
 *
 * - COR-005: two Claude Code processes on one session_id alternate.
 * - REL-005: a shard directory that cannot be written.
 * - COR-009: one session's lower-bound figure marks other sessions' Today:.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

const LAYOUT = { lines: [{ widgets: [{ type: "session-cost" }, { type: "today-spend" }] }] };

let dir: string;
let cacheHome: string;
let refusedPricingUrl: string;
let refresher: RefresherSuppression;

beforeAll(async () => {
  refusedPricingUrl = await reserveRefusedUrl();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-store-"));
  cacheHome = path.join(dir, "cache");
  fs.mkdirSync(path.join(cacheHome, "gccusage"), { recursive: true });
  refresher = suppressPricingRefresh(cacheHome, refusedPricingUrl);
  const configDir = path.join(dir, "config", "gccusage");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(LAYOUT));
});

afterEach(() => {
  refresher.assertNotSpawned();
  fs.chmodSync(path.join(cacheHome, "gccusage"), 0o755);
  const daily = path.join(cacheHome, "gccusage", "daily");
  if (fs.existsSync(daily) && fs.statSync(daily).isDirectory()) fs.chmodSync(daily, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

function render(payload: Record<string, unknown>): { out: string; status: number } {
  try {
    const out = execFileSync(process.execPath, [DIST], {
      cwd: dir,
      input: JSON.stringify(payload),
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
    return { out: stripAnsi(out), status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: stripAnsi(e.stdout ?? ""), status: e.status ?? -1 };
  }
}

const MIN = 60_000;

describe.skipIf(!distExists)("daily store through the real bundle", () => {
  it("keeps Today exact while two processes alternate on one session (COR-005)", () => {
    // Each process's first render is at its start (Claude Code renders the
    // statusline when it starts), so B starts while A has run for a while.
    // Durations are what each payload would carry at render time; real time
    // between these renders is a fraction of a second. The costs are each
    // process's own cumulative figure. True spend: 5.2 + 1.2 = 6.40.
    let last = "";
    const renders: Array<[number, number]> = [
      [60 * MIN, 0], [2000, 0],
      [60 * MIN, 5], [3000, 1], [60 * MIN + 1000, 5.1],
      [4000, 1.1], [60 * MIN + 2000, 5.2], [5000, 1.2],
    ];
    for (const [duration, cost] of renders) {
      last = render({
        session_id: "dup",
        cost: { total_cost_usd: cost, total_duration_ms: duration },
      }).out;
    }
    expect(last).toContain("Today: $6.40");
  });

  it("renders the bar, with Today marked, when the shard directory is unwritable (REL-005)", () => {
    const daily = path.join(cacheHome, "gccusage", "daily");
    fs.mkdirSync(daily, { recursive: true });
    fs.chmodSync(daily, 0o555);

    const { out, status } = render({ session_id: "ro", cost: { total_cost_usd: 1.5 } });

    expect(status).toBe(0);
    expect(out).toContain("$1.50");
    expect(out).toContain("Today: $1.50?");
  });

  it("marks another session's Today while one session's figure is a lower bound (COR-009)", () => {
    // Session A has no stdin cost, so it is calculated from a transcript
    // whose only model is unpriced: a lower bound, stored as uncertain.
    const projectDir = path.join(dir, ".claude", "projects", "p");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "sess-a.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(Date.now() - MIN).toISOString(),
        message: { id: "m1", model: "claude-unpriced-9", usage: { input_tokens: 1000, output_tokens: 10 } },
      }) + "\n",
    );
    render({ session_id: "sess-a" });

    const b = render({ session_id: "sess-b", cost: { total_cost_usd: 2 } }).out;
    expect(b).toContain("$2.00");
    expect(b).toMatch(/Today: \$2\.00\?/);
  });
});
