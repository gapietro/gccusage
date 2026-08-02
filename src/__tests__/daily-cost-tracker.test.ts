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

function shardDir(): string {
  return path.join(tmpDir, "gccusage", "daily");
}

describe("trackDailyCost", () => {
  it("sums multiple sessions for the same day", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.5, "stdin", now);
    const total = trackDailyCost("session-b", 1.5, "stdin", now);
    expect(total).toBeCloseTo(4.0);
  });

  it("updates an existing session instead of double-counting", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.5, "stdin", now);
    const total = trackDailyCost("session-a", 3.0, "stdin", now);
    expect(total).toBeCloseTo(3.0);
  });

  it("only counts post-midnight spend for a session that crosses midnight", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 5.0, "stdin", yesterday); // $5 spent yesterday

    const today = new Date(2026, 6, 29, 1, 0, 0);
    const total = trackDailyCost("session-a", 7.0, "stdin", today); // $2 more today
    expect(total).toBeCloseTo(2.0);
  });

  it("resets the baseline when a session id reappears with a lower cost", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 5.0, "stdin", yesterday);

    const today = new Date(2026, 6, 29, 9, 0, 0);
    const total = trackDailyCost("session-a", 0.5, "stdin", today); // restarted session
    expect(total).toBeCloseTo(0.5);
  });

  it("preserves today's accrued spend when a session restarts with a lower cost", () => {
    const morning = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 15.0, "stdin", morning); // $15 spent today

    const later = new Date(2026, 6, 29, 11, 0, 0);
    const total = trackDailyCost("session-a", 1.0, "stdin", later); // restarted, $1 in new process
    expect(total).toBeCloseTo(16.0);
  });

  it("preserves post-midnight spend when a restarted session's cost drops below its baseline", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 10.0, "stdin", yesterday); // $10 spent yesterday

    const morning = new Date(2026, 6, 29, 9, 0, 0);
    trackDailyCost("session-a", 15.0, "stdin", morning); // $5 more today

    const later = new Date(2026, 6, 29, 11, 0, 0);
    const total = trackDailyCost("session-a", 1.0, "stdin", later); // restarted, $1 in new process
    expect(total).toBeCloseTo(6.0);
  });

  it("accumulates spend across repeated same-day restarts", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 3.0, "stdin", now);
    trackDailyCost("session-a", 0.5, "stdin", new Date(2026, 6, 29, 11, 0, 0)); // restart 1
    trackDailyCost("session-a", 2.0, "stdin", new Date(2026, 6, 29, 12, 0, 0));
    const total = trackDailyCost("session-a", 1.0, "stdin", new Date(2026, 6, 29, 13, 0, 0)); // restart 2
    expect(total).toBeCloseTo(6.0); // 3 + 2 + 1
  });

  it("drops sessions not updated for 48h on rollover", () => {
    const twoDaysAgo = new Date(2026, 6, 26, 10, 0, 0);
    trackDailyCost("stale", 9.0, "stdin", twoDaysAgo);

    const now = new Date(2026, 6, 29, 10, 0, 0);
    const total = trackDailyCost("fresh", 1.0, "stdin", now);
    expect(total).toBeCloseTo(1.0);
  });

  it("re-baselines without a restart fold when the cost source switches", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    // JSONL-derived cost persisted while stdin carried no cost (auto fallback)
    trackDailyCost("session-a", 5.0, "calculated", now);

    // stdin cost appears, lower than the calculated value — a source switch,
    // not a session restart; today's total must not inflate
    const total = trackDailyCost("session-a", 3.0, "stdin", new Date(2026, 6, 29, 10, 0, 5));
    expect(total).toBeCloseTo(5.0);
  });

  it("keeps accruing in the new source after a switch", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 5.0, "calculated", now);
    trackDailyCost("session-a", 3.0, "stdin", new Date(2026, 6, 29, 10, 0, 5));

    const total = trackDailyCost("session-a", 4.0, "stdin", new Date(2026, 6, 29, 10, 0, 10));
    expect(total).toBeCloseTo(6.0);
  });

  it("still folds a genuine restart within the same source", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 15.0, "stdin", now);

    const total = trackDailyCost("session-a", 1.0, "stdin", new Date(2026, 6, 29, 11, 0, 0));
    expect(total).toBeCloseTo(16.0);
  });

  it("treats a stored entry without a source as the incoming source", () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(cacheDir, { recursive: true });
    const now = new Date(2026, 6, 29, 10, 0, 0);
    fs.writeFileSync(
      path.join(cacheDir, "daily-costs.json"),
      JSON.stringify({
        date: "2026-07-29",
        sessions: [
          { sessionId: "old", costUsd: 5.0, baselineUsd: 0, updatedAt: now.getTime() },
        ],
      }),
    );
    // Legacy entry has no source; a lower cost keeps restart semantics
    const total = trackDailyCost("old", 1.0, "stdin", now);
    expect(total).toBeCloseTo(6.0);
  });

  it("keeps each session in its own file", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.5, "stdin", now);
    trackDailyCost("session-b", 1.5, "stdin", now);

    expect(fs.readdirSync(shardDir()).sort()).toEqual(["session-a.json", "session-b.json"]);
  });

  it("does not touch another session's file when recording a session", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-b", 1.5, "stdin", now);
    const before = fs.readFileSync(path.join(shardDir(), "session-b.json"), "utf-8");

    trackDailyCost("session-a", 2.5, "stdin", now);

    const after = fs.readFileSync(path.join(shardDir(), "session-b.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("does not lose a session that was recorded from a stale view of the store", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    // Two renders that both read the store before either writes: with a
    // single shared file the second write erases the first session's entry.
    const storeBeforeEither = fs.existsSync(shardDir())
      ? fs.readdirSync(shardDir())
      : [];
    expect(storeBeforeEither).toEqual([]);

    trackDailyCost("session-a", 4.0, "stdin", now);
    const total = trackDailyCost("session-b", 6.0, "stdin", now);

    expect(total).toBeCloseTo(10.0);
    expect(fs.readdirSync(shardDir()).sort()).toEqual(["session-a.json", "session-b.json"]);
  });

  it("keeps a session id with path separators inside the cache directory", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    const total = trackDailyCost("../../evil", 3.0, "stdin", now);

    expect(total).toBeCloseTo(3.0);
    expect(fs.existsSync(path.join(tmpDir, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "evil.json"))).toBe(false);
    const shards = fs.readdirSync(shardDir());
    expect(shards).toHaveLength(1);
    expect(shards[0]).toMatch(/^[a-f0-9]{16}\.json$/);
  });

  it("deletes the file of a session untouched for 48h", () => {
    const twoDaysAgo = new Date(2026, 6, 26, 10, 0, 0);
    trackDailyCost("stale", 9.0, "stdin", twoDaysAgo);

    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("fresh", 1.0, "stdin", now);

    expect(fs.readdirSync(shardDir())).toEqual(["fresh.json"]);
  });

  it("counts nothing from a session whose file is from an earlier day", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 5.0, "stdin", yesterday);
    const yesterdayShard = fs.readFileSync(path.join(shardDir(), "session-a.json"), "utf-8");

    const today = new Date(2026, 6, 29, 1, 0, 0);
    const total = trackDailyCost("session-b", 2.0, "stdin", today);

    expect(total).toBeCloseTo(2.0);
    // The reader must not rewrite another session's shard to re-baseline it.
    expect(fs.readFileSync(path.join(shardDir(), "session-a.json"), "utf-8")).toBe(
      yesterdayShard,
    );
  });

  it("migrates a legacy single-file store into per-session files", () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(cacheDir, { recursive: true });
    const now = new Date(2026, 6, 29, 10, 0, 0);
    fs.writeFileSync(
      path.join(cacheDir, "daily-costs.json"),
      JSON.stringify({
        date: "2026-07-29",
        sessions: [
          { sessionId: "a", costUsd: 5.0, baselineUsd: 1.0, source: "stdin", updatedAt: now.getTime() },
          { sessionId: "b", costUsd: 2.0, baselineUsd: 0, source: "stdin", updatedAt: now.getTime() },
        ],
      }),
    );

    const total = trackDailyCost("c", 3.0, "stdin", now);

    expect(total).toBeCloseTo(9.0); // (5-1) + 2 + 3
    expect(fs.readdirSync(shardDir()).sort()).toEqual(["a.json", "b.json", "c.json"]);
    expect(fs.existsSync(path.join(cacheDir, "daily-costs.json"))).toBe(false);
  });

  it("ignores an unparseable session file instead of losing the rest of the day", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("good", 4.0, "stdin", now);
    fs.writeFileSync(path.join(shardDir(), "corrupt.json"), "{ truncated");

    const total = trackDailyCost("other", 1.0, "stdin", now);
    expect(total).toBeCloseTo(5.0);
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
    const total = trackDailyCost(undefined, 0, "stdin", now);
    expect(total).toBeCloseTo(2.0);
  });
});
