import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeCache } from "../cache/cache-manager.js";
import { runStatusline } from "../statusline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { StatusJson } from "../types/status-json.js";

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-statusline-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readDailyCosts(): {
  date: string;
  sessions: Array<{ sessionId: string; costUsd: number; baselineUsd: number }>;
} {
  const raw = fs.readFileSync(
    path.join(tmpDir, "gccusage", "daily-costs.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

describe("runStatusline cache hits", () => {
  it("returns the cached output on a cache hit", async () => {
    writeCache("cached-line", "session-a");
    const stdin: StatusJson = {
      session_id: "session-a",
      cost: { total_cost_usd: 1.25 },
    };

    const output = await runStatusline(stdin, DEFAULT_SETTINGS);

    expect(output).toBe("cached-line");
  });

  it("tracks daily cost from stdin even on a cache hit", async () => {
    writeCache("cached-line", "session-a");
    const stdin: StatusJson = {
      session_id: "session-a",
      cost: { total_cost_usd: 1.25 },
    };

    await runStatusline(stdin, DEFAULT_SETTINGS);

    const data = readDailyCosts();
    const entry = data.sessions.find((s) => s.sessionId === "session-a");
    expect(entry?.costUsd).toBe(1.25);
  });

  it("updates a previously tracked cost when stdin cost changed", async () => {
    writeCache("cached-line", "session-a");
    await runStatusline(
      { session_id: "session-a", cost: { total_cost_usd: 1.25 } },
      DEFAULT_SETTINGS,
    );

    await runStatusline(
      { session_id: "session-a", cost: { total_cost_usd: 2.5 } },
      DEFAULT_SETTINGS,
    );

    const data = readDailyCosts();
    const entry = data.sessions.find((s) => s.sessionId === "session-a");
    expect(entry?.costUsd).toBe(2.5);
  });

  it("does not track stdin cost on cache hit when costSource is calculated", async () => {
    writeCache("cached-line", "session-a");
    const settings: Settings = { ...DEFAULT_SETTINGS, costSource: "calculated" };

    await runStatusline(
      { session_id: "session-a", cost: { total_cost_usd: 1.25 } },
      settings,
    );

    expect(
      fs.existsSync(path.join(tmpDir, "gccusage", "daily-costs.json")),
    ).toBe(false);
  });
});
