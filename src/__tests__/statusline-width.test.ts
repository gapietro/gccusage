import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripAnsi } from "../utils/terminal.js";
import { PRICING_CACHE_VERSION } from "../cache/pricing-cache.js";

// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

/** A widget label wide enough that an 80-column budget must cut it. */
const WIDE_LABEL = "W".repeat(140);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-width-"));

  const configDir = path.join(dir, "config", "gccusage");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      powerline: { enabled: false },
      compact: { mode: "never" },
      lines: [{ widgets: [{ type: "custom-text", text: WIDE_LABEL }] }],
    }),
  );

  // Seed the pricing cache so the child never reaches the network. Without
  // this, fetchPricing waits out a 5s timeout per spawn whenever the network
  // is slow or blocked.
  const cacheDir = path.join(dir, "cache", "gccusage");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "pricing.json"),
    JSON.stringify({ version: PRICING_CACHE_VERSION, timestamp: Date.now(), data: {} }),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runStatusline(columns: string | undefined): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  };
  if (columns === undefined) delete env["COLUMNS"];
  else env["COLUMNS"] = columns;

  // A distinct session id per call: the statusline cache keys on
  // (sessionId, costUsd) with a 5s TTL, so reusing one id would serve the
  // first render back for the second width and the test would pass blind.
  const sessionId = `width-test-${columns ?? "unset"}`;

  // stdio "pipe" on stdout is the point of this test: it reproduces the
  // condition under which process.stdout.columns is undefined.
  return execFileSync(process.execPath, [DIST], {
    input: JSON.stringify({ session_id: sessionId, cost: { total_cost_usd: 1 } }),
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe.skipIf(!distExists)("statusline width through a real pipe", () => {
  it("renders to the width COLUMNS advertises, not to 80", () => {
    const visible = stripAnsi(runStatusline("200")).trimEnd();
    expect(visible.length).toBeGreaterThan(80);
    expect(visible).toContain(WIDE_LABEL);
  });

  it("truncates to a narrow COLUMNS", () => {
    const visible = stripAnsi(runStatusline("40")).trimEnd();
    expect(visible.length).toBeLessThanOrEqual(40);
    expect(visible.endsWith("…")).toBe(true);
  });

  it("does not truncate when COLUMNS is absent", () => {
    const visible = stripAnsi(runStatusline(undefined)).trimEnd();
    expect(visible).toContain(WIDE_LABEL);
  });
});
