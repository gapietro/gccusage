import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackDailyCost } from "../data/daily-cost-tracker.js";

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-test-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("trackDailyCost", () => {
  it("sums multiple sessions for the same day", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.5, now);
    const total = trackDailyCost("session-b", 1.5, now);
    expect(total).toBeCloseTo(4.0);
  });

  it("updates an existing session instead of double-counting", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.5, now);
    const total = trackDailyCost("session-a", 3.0, now);
    expect(total).toBeCloseTo(3.0);
  });

  it("only counts post-midnight spend for a session that crosses midnight", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 5.0, yesterday); // $5 spent yesterday

    const today = new Date(2026, 6, 29, 1, 0, 0);
    const total = trackDailyCost("session-a", 7.0, today); // $2 more today
    expect(total).toBeCloseTo(2.0);
  });

  it("resets the baseline when a session id reappears with a lower cost", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 5.0, yesterday);

    const today = new Date(2026, 6, 29, 9, 0, 0);
    const total = trackDailyCost("session-a", 0.5, today); // restarted session
    expect(total).toBeCloseTo(0.5);
  });

  it("preserves today's accrued spend when a session restarts with a lower cost", () => {
    const morning = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 15.0, morning); // $15 spent today

    const later = new Date(2026, 6, 29, 11, 0, 0);
    const total = trackDailyCost("session-a", 1.0, later); // restarted, $1 in new process
    expect(total).toBeCloseTo(16.0);
  });

  it("preserves post-midnight spend when a restarted session's cost drops below its baseline", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 10.0, yesterday); // $10 spent yesterday

    const morning = new Date(2026, 6, 29, 9, 0, 0);
    trackDailyCost("session-a", 15.0, morning); // $5 more today

    const later = new Date(2026, 6, 29, 11, 0, 0);
    const total = trackDailyCost("session-a", 1.0, later); // restarted, $1 in new process
    expect(total).toBeCloseTo(6.0);
  });

  it("accumulates spend across repeated same-day restarts", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 3.0, now);
    trackDailyCost("session-a", 0.5, new Date(2026, 6, 29, 11, 0, 0)); // restart 1
    trackDailyCost("session-a", 2.0, new Date(2026, 6, 29, 12, 0, 0));
    const total = trackDailyCost("session-a", 1.0, new Date(2026, 6, 29, 13, 0, 0)); // restart 2
    expect(total).toBeCloseTo(6.0); // 3 + 2 + 1
  });

  it("drops sessions not updated for 48h on rollover", () => {
    const twoDaysAgo = new Date(2026, 6, 26, 10, 0, 0);
    trackDailyCost("stale", 9.0, twoDaysAgo);

    const now = new Date(2026, 6, 29, 10, 0, 0);
    const total = trackDailyCost("fresh", 1.0, now);
    expect(total).toBeCloseTo(1.0);
  });

  it("treats an old-format file without baselines as baseline 0", () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(cacheDir, { recursive: true });
    const now = new Date(2026, 6, 29, 10, 0, 0);
    fs.writeFileSync(
      path.join(cacheDir, "daily-costs.json"),
      JSON.stringify({
        date: "2026-07-29",
        sessions: [{ sessionId: "old", costUsd: 2.0, updatedAt: now.getTime() }],
      }),
    );
    const total = trackDailyCost(undefined, 0, now);
    expect(total).toBeCloseTo(2.0);
  });
});
