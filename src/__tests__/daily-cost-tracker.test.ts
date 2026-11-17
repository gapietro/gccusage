import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackDailyCost, recordDailyCost } from "../data/daily-cost-tracker.js";

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

  it("keeps the legacy store when a shard write fails mid-migration", () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(cacheDir, { recursive: true });
    const now = new Date(2026, 6, 29, 10, 0, 0);
    const legacyPath = path.join(cacheDir, "daily-costs.json");
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        date: "2026-07-29",
        sessions: [
          { sessionId: "a", costUsd: 5.0, baselineUsd: 0, updatedAt: now.getTime() },
          { sessionId: "b", costUsd: 2.0, baselineUsd: 0, updatedAt: now.getTime() },
        ],
      }),
    );
    // A plain file where the shard directory belongs makes every shard write
    // fail with ENOTDIR — a stand-in for a full disk or a permissions error.
    fs.writeFileSync(shardDir(), "not a directory");

    trackDailyCost(undefined, 0, "stdin", now);

    // Both sessions still exist only in the legacy store, so it must survive to
    // be retried — deleting it here would drop their spend for the rest of the
    // day, which is the loss the migration exists to prevent.
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(legacyPath, "utf-8")).sessions).toHaveLength(2);
  });

  it("discards an unparseable legacy store instead of retrying it forever", () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(cacheDir, { recursive: true });
    const legacyPath = path.join(cacheDir, "daily-costs.json");
    fs.writeFileSync(legacyPath, "{ truncated");

    const now = new Date(2026, 6, 29, 10, 0, 0);
    const total = trackDailyCost("a", 1.0, "stdin", now);

    expect(total).toBeCloseTo(1.0);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("discards a legacy store whose sessions are not an array", () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(cacheDir, { recursive: true });
    const legacyPath = path.join(cacheDir, "daily-costs.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ date: "2026-07-29", sessions: {} }));

    const now = new Date(2026, 6, 29, 10, 0, 0);
    const total = trackDailyCost("a", 1.0, "stdin", now);

    expect(total).toBeCloseTo(1.0);
    expect(fs.existsSync(legacyPath)).toBe(false);
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

// #145: `JSON.stringify(Infinity|NaN)` is `null`, and `ShardSchema` rejects a
// null `costUsd` on read, so persisting a non-finite cost silently dropped the
// session from the store and lost its baseline. A non-finite cost must leave
// the shard's figures exactly as they were. These read the shard's raw bytes,
// not a re-parsed value, because the bug was in what reached disk.
//
// Since COR-009 the shard is not byte-identical: it is re-stamped
// `"uncertain": true`, so other sessions' bars mark the stale figure. Every
// other field must be unchanged, which is what #145 required.
describe("trackDailyCost with a non-finite session cost (#145)", () => {
  function shardBytes(sessionId: string): string | null {
    const file = path.join(shardDir(), `${sessionId}.json`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  }

  /** The raw shard text must hold no null and match `before` except for the flag. */
  function expectFiguresUnchanged(after: string | null, before: string | null): void {
    expect(after).not.toBeNull();
    expect(after).not.toContain("null");
    const a = JSON.parse(after!) as Record<string, unknown>;
    const b = JSON.parse(before!) as Record<string, unknown>;
    expect(a["uncertain"]).toBe(true);
    expect({ ...a, uncertain: undefined }).toEqual({ ...b, uncertain: undefined });
  }

  it.each([Infinity, -Infinity, NaN])("leaves an existing shard untouched for %s", (bad) => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.5, "calculated", now);
    const before = shardBytes("session-a");

    const later = new Date(2026, 6, 29, 10, 5, 0);
    const total = trackDailyCost("session-a", bad, "calculated", later);

    expectFiguresUnchanged(shardBytes("session-a"), before);
    // Today still counts this session's last good figure.
    expect(total).toBeCloseTo(2.5);
  });

  it("keeps a carried-over session's baseline, so yesterday's spend is never counted as today's", () => {
    const yesterday = new Date(2026, 6, 28, 23, 0, 0);
    trackDailyCost("session-a", 5.0, "calculated", yesterday);

    const today = new Date(2026, 6, 29, 1, 0, 0);
    trackDailyCost("session-a", Infinity, "calculated", today);
    // Next good render: $2 spent since midnight, not $7.
    const total = trackDailyCost("session-a", 7.0, "calculated", new Date(2026, 6, 29, 1, 5, 0));
    expect(total).toBeCloseTo(2.0);
  });

  // Since COR-009 a placeholder is stored, so other sessions' bars mark
  // Today instead of silently omitting this session. #145's requirement is
  // unchanged: nothing non-finite (no null) reaches disk.
  it("stores a finite, uncertain placeholder for a new session whose first cost is non-finite", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-b", 1.5, "calculated", now);
    const total = trackDailyCost("session-a", Infinity, "calculated", now);

    const raw = shardBytes("session-a");
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("null");
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed["costUsd"]).toBe(0);
    expect(parsed["uncertain"]).toBe(true);
    expect(total).toBeCloseTo(1.5);
  });

  it("keeps other sessions in today's total", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("session-a", 2.0, "stdin", now);
    trackDailyCost("session-b", 1.0, "calculated", now);
    const total = trackDailyCost("session-b", NaN, "calculated", now);
    expect(total).toBeCloseTo(3.0);
  });
});

// Review follow-up to #145: guarding the incoming cost is not enough, because
// the re-baseline arithmetic can overflow on finite inputs. Here the stored
// cost and baseline are each finite but differ by more than Number.MAX_VALUE,
// so `accruedToday` is Infinity and a source switch would derive a baseline of
// -Infinity, written as "baselineUsd": null and read back as 0.
describe("trackDailyCost never writes a derived non-finite baseline", () => {
  it("leaves the shard untouched when a source switch's re-baseline overflows", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("s", 1e308, "stdin", now);
    trackDailyCost("s", -1e308, "stdin", now); // restart branch: baseline -1e308
    trackDailyCost("s", 1e308, "stdin", now); // stored {1e308, -1e308}
    const file = path.join(shardDir(), "s.json");
    const before = fs.readFileSync(file, "utf-8");

    trackDailyCost("s", 1, "calculated", now); // source switch

    const after = fs.readFileSync(file, "utf-8");
    expect(after).not.toContain("null");
    const a = JSON.parse(after) as Record<string, unknown>;
    expect(a["uncertain"]).toBe(true);
    expect({ ...a, uncertain: undefined }).toEqual({ ...(JSON.parse(before) as object), uncertain: undefined });
  });
});

// ---------------------------------------------------------------------------
// Audit 2026-11-16 (COR-005, COR-009, REL-005). `recordDailyCost` is the
// pipeline's entry point; `trackDailyCost` is its number-only wrapper.
// ---------------------------------------------------------------------------

const MIN = 60_000;

describe("per-process entries (COR-005)", () => {
  // Two Claude Code processes on one session_id (`--resume <id>` in a second
  // terminal) each report their own cumulative cost. Keyed by session alone,
  // every alternation read as a restart and Today absorbed the other
  // process's whole cumulative cost: $16.50 for a true spend of $6.40.
  // Each process's first render is at its start, as Claude Code renders the
  // statusline when its controller starts; then the two alternate.
  it("does not inflate Today when two processes alternate on one session", () => {
    const startA = new Date(2026, 6, 29, 9, 0, 0).getTime();
    const startB = startA + 55 * MIN;
    const renders: Array<[number, number, number]> = [
      [startA, 0, startA + 2000],
      [startB, 0, startB + 2000],
      [startA, 5, startB + MIN], [startB, 1, startB + MIN + 1000],
      [startA, 5.1, startB + MIN + 2000], [startB, 1.1, startB + MIN + 3000],
      [startA, 5.2, startB + MIN + 4000], [startB, 1.2, startB + MIN + 5000],
    ];
    let result = { totalUsd: 0, uncertain: false };
    for (const [processStart, cost, at] of renders) {
      result = recordDailyCost({ sessionId: "dup", costUsd: cost, source: "stdin", processStart }, new Date(at));
    }
    expect(result.totalUsd).toBeCloseTo(6.4);
  });

  // `--resume` restores the cumulative cost (Claude Code's cost tracker
  // `restore()`), so the resumed process's first figure is the previous
  // process's total. Counting it again would double the session.
  it("counts only new spend for a resumed process that restored its cost", () => {
    const t0 = new Date(2026, 6, 29, 10, 0, 0).getTime();
    recordDailyCost({ sessionId: "s", costUsd: 0, source: "stdin", processStart: t0 }, new Date(t0));
    recordDailyCost({ sessionId: "s", costUsd: 5, source: "stdin", processStart: t0 }, new Date(t0 + 30 * MIN));
    // Process exits; later resumed with its cost restored and its clock continued.
    const resumed = t0 + 90 * MIN - 30 * MIN;
    recordDailyCost({ sessionId: "s", costUsd: 5, source: "stdin", processStart: resumed }, new Date(t0 + 90 * MIN));
    const r = recordDailyCost({ sessionId: "s", costUsd: 6, source: "stdin", processStart: resumed }, new Date(t0 + 95 * MIN));
    expect(r.totalUsd).toBeCloseTo(6);
  });

  it("matches one process across renders despite spawn-delay jitter", () => {
    const t0 = new Date(2026, 6, 29, 10, 0, 0).getTime();
    recordDailyCost({ sessionId: "j", costUsd: 1, source: "stdin", processStart: t0 }, new Date(t0 + MIN));
    recordDailyCost({ sessionId: "j", costUsd: 2, source: "stdin", processStart: t0 + 2000 }, new Date(t0 + 2 * MIN));
    const r = recordDailyCost({ sessionId: "j", costUsd: 3, source: "stdin", processStart: t0 + 800 }, new Date(t0 + 3 * MIN));
    expect(r.totalUsd).toBeCloseTo(3);
    expect(fs.readdirSync(shardDir()).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  // A process that was already running when this version was installed has a
  // session-keyed shard. Its first process-keyed render must not recount it.
  it("carries a pre-upgrade session-keyed entry without double counting", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    trackDailyCost("u", 3, "stdin", now); // legacy shape: no processStart
    const start = now.getTime() - 20 * MIN;
    recordDailyCost({ sessionId: "u", costUsd: 3, source: "stdin", processStart: start }, new Date(now.getTime() + MIN));
    const r = recordDailyCost({ sessionId: "u", costUsd: 4, source: "stdin", processStart: start }, new Date(now.getTime() + 2 * MIN));
    expect(r.totalUsd).toBeCloseTo(4);
  });

  it("keeps a session's first process counting from zero", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    const r = recordDailyCost(
      { sessionId: "first", costUsd: 2.5, source: "stdin", processStart: now.getTime() - 30_000 },
      now,
    );
    expect(r.totalUsd).toBeCloseTo(2.5);
  });
});

describe("Today's uncertainty is stored, not per-render (COR-009)", () => {
  it("marks every session's Today while one session's figure is a lower bound", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    recordDailyCost({ sessionId: "a", costUsd: 0.2, source: "calculated", uncertain: true }, now);
    const b = recordDailyCost({ sessionId: "b", costUsd: 1, source: "stdin" }, now);
    expect(b.totalUsd).toBeCloseTo(1.2);
    expect(b.uncertain).toBe(true);

    recordDailyCost({ sessionId: "a", costUsd: 0.3, source: "calculated" }, now);
    expect(recordDailyCost({ sessionId: "b", costUsd: 1, source: "stdin" }, now).uncertain).toBe(false);
  });

  // #145 kept the stale figure but flagged it only on the overflowing
  // session's own bar; every other session showed it unmarked.
  it("flags a session whose latest cost could not be recorded on other sessions' bars", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    recordDailyCost({ sessionId: "a", costUsd: 0.2, source: "calculated" }, now);
    const own = recordDailyCost({ sessionId: "a", costUsd: Infinity, source: "calculated" }, now);
    expect(own.uncertain).toBe(true);
    const other = recordDailyCost({ sessionId: "b", costUsd: 1, source: "stdin" }, now);
    expect(other.totalUsd).toBeCloseTo(1.2);
    expect(other.uncertain).toBe(true);
  });

  it("reports a skipped overflowing re-baseline as uncertain", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    recordDailyCost({ sessionId: "s", costUsd: 1e308, source: "stdin" }, now);
    recordDailyCost({ sessionId: "s", costUsd: -1e308, source: "stdin" }, now);
    recordDailyCost({ sessionId: "s", costUsd: 1e308, source: "stdin" }, now);
    expect(recordDailyCost({ sessionId: "s", costUsd: 1, source: "calculated" }, now).uncertain).toBe(true);
  });

  it("is certain for an ordinary day", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    recordDailyCost({ sessionId: "a", costUsd: 1, source: "stdin" }, now);
    expect(recordDailyCost({ sessionId: "b", costUsd: 2, source: "stdin" }, now).uncertain).toBe(false);
  });
});

describe("a shard that cannot be written (REL-005)", () => {
  // The shard write was the one render-path write with no catch: a root-owned
  // or full cache directory threw into main().catch() and erased the bar on
  // every render, for every session.
  it("returns today's total, marked uncertain, instead of throwing", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    recordDailyCost({ sessionId: "a", costUsd: 1, source: "stdin" }, now);
    fs.chmodSync(shardDir(), 0o555);
    try {
      const r = recordDailyCost({ sessionId: "b", costUsd: 2, source: "stdin" }, now);
      expect(r.totalUsd).toBeCloseTo(3);
      expect(r.uncertain).toBe(true);
    } finally {
      fs.chmodSync(shardDir(), 0o755);
    }
  });

  it("survives a cache path whose shard directory is a file", () => {
    fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
    fs.writeFileSync(shardDir(), "not a directory");
    const r = recordDailyCost({ sessionId: "a", costUsd: 2, source: "stdin" }, new Date(2026, 6, 29, 10));
    expect(r.totalUsd).toBeCloseTo(2);
    expect(r.uncertain).toBe(true);
  });
});

describe("per-process shard identity (COR-005)", () => {
  // Found by the bundle test: keeping the minimum start renamed the shard
  // whenever a render's spawn delay was shorter than before, leaving the old
  // file behind and counted. Each process must keep exactly one file.
  it("keeps one shard per process when the estimated start moves earlier", () => {
    const t0 = new Date(2026, 6, 29, 10, 0, 0).getTime();
    recordDailyCost({ sessionId: "m", costUsd: 5, source: "stdin", processStart: t0 }, new Date(t0 + 1000));
    recordDailyCost({ sessionId: "m", costUsd: 5.1, source: "stdin", processStart: t0 - 900 }, new Date(t0 + 2000));
    const r = recordDailyCost({ sessionId: "m", costUsd: 5.2, source: "stdin", processStart: t0 - 1800 }, new Date(t0 + 3000));
    expect(fs.readdirSync(shardDir()).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(r.totalUsd).toBeCloseTo(5.2);
  });
});

// ---------------------------------------------------------------------------
// Review of the COR-005 fix: scenarios that were right before and must stay
// right, plus mutants that survived the first round of tests.
// ---------------------------------------------------------------------------

describe("per-process entries: review follow-ups (COR-005)", () => {
  const T0 = new Date(2026, 6, 29, 10, 0, 0).getTime();
  const rec = (input: Parameters<typeof recordDailyCost>[0], at: number) =>
    recordDailyCost(input, new Date(at));

  // A calculated cost is the whole session's transcript, not one process's,
  // so two processes report the same series. Keyed per process, each counted
  // every increment: $5.40 for $5.20.
  it("keys calculated costs by session, so two processes reporting one series count it once", () => {
    const a = T0 - 60 * MIN;
    const b = T0 - 5 * MIN;
    let r = { totalUsd: 0, uncertain: false };
    [[a, 5], [b, 5], [a, 5.1], [b, 5.1], [a, 5.2], [b, 5.2]].forEach(([ps, c], i) => {
      r = rec({ sessionId: "s", costUsd: c!, source: "calculated", processStart: ps }, T0 + i * 1000);
    });
    expect(r.totalUsd).toBeCloseTo(5.2);
  });

  it("does not split one process whose payload sometimes lacks a duration", () => {
    const ps = T0 - 5000;
    rec({ sessionId: "s", costUsd: 5, source: "stdin", processStart: ps }, T0);
    expect(rec({ sessionId: "s", costUsd: 5.1, source: "stdin" }, T0 + 1000).totalUsd).toBeCloseTo(5.1);
    expect(rec({ sessionId: "s", costUsd: 5.2, source: "stdin", processStart: ps }, T0 + 2000).totalUsd).toBeCloseTo(5.2);
  });

  it("carries a calculated figure into a later stdin process figure without double counting", () => {
    rec({ sessionId: "s", costUsd: 5.5, source: "calculated" }, T0);
    const ps = T0 - 5000; // early first render: only the other-source rule applies
    expect(rec({ sessionId: "s", costUsd: 5.0, source: "stdin", processStart: ps }, T0 + 1000).totalUsd).toBeCloseTo(5.5);
    expect(rec({ sessionId: "s", costUsd: 5.3, source: "stdin", processStart: ps }, T0 + 2000).totalUsd).toBeCloseTo(5.8);
  });

  // The calculated $5.50 and the stdin $6.00 are the same spend on two
  // scales, so the stdin figure must not baseline against the calculated one.
  it("does not baseline a stdin process against a calculated figure it exceeds", () => {
    rec({ sessionId: "s", costUsd: 5.5, source: "calculated" }, T0);
    const ps = T0 - 5000;
    expect(rec({ sessionId: "s", costUsd: 6.0, source: "stdin", processStart: ps }, T0 + 1000).totalUsd).toBeCloseTo(5.5);
    expect(rec({ sessionId: "s", costUsd: 6.3, source: "stdin", processStart: ps }, T0 + 2000).totalUsd).toBeCloseTo(5.8);
  });

  // `--resume --fork-session` restores the parent's cost under a NEW
  // session_id, and a resume after the 48 h prune has no entry to baseline
  // against. Its clock is restored too, so its first render is already
  // minutes or hours into the process.
  it("does not count a restored cost as today's spend when there is no entry to baseline against", () => {
    const ps = T0 - 3 * 60 * MIN; // first render three hours into the process
    expect(rec({ sessionId: "fork", costUsd: 10, source: "stdin", processStart: ps }, T0).totalUsd).toBeCloseTo(0);
    expect(rec({ sessionId: "fork", costUsd: 11, source: "stdin", processStart: ps }, T0 + MIN).totalUsd).toBeCloseTo(1);
  });

  it("still counts a new session's first render from zero", () => {
    const ps = T0 - 20_000; // 20 s in
    expect(rec({ sessionId: "new", costUsd: 0.4, source: "stdin", processStart: ps }, T0).totalUsd).toBeCloseTo(0.4);
  });

  it("keeps two processes started 15 s apart separate", () => {
    let r = { totalUsd: 0, uncertain: false };
    [[T0, 3], [T0 + 15_000, 1], [T0, 3.2], [T0 + 15_000, 1.1]].forEach(([ps, c], i) => {
      r = rec({ sessionId: "s", costUsd: c!, source: "stdin", processStart: ps }, T0 + 60_000 + i * 1000);
    });
    expect(r.totalUsd).toBeCloseTo(4.3);
  });

  it("counts only new spend for a process resumed the next day", () => {
    const yesterday = new Date(2026, 6, 28, 22, 0, 0).getTime();
    rec({ sessionId: "s", costUsd: 7, source: "stdin", processStart: yesterday - MIN }, yesterday);
    // The previous run lasted a minute, so the restored clock puts this first
    // render 60 s in: too early for the late-render rule, so only yesterday's
    // stored figure can supply the baseline.
    const ps = T0 - 60_000;
    expect(rec({ sessionId: "s", costUsd: 7, source: "stdin", processStart: ps }, T0).totalUsd).toBeCloseTo(0);
    expect(rec({ sessionId: "s", costUsd: 8, source: "stdin", processStart: ps }, T0 + MIN).totalUsd).toBeCloseTo(1);
  });
});

describe("stored uncertainty: review follow-ups (COR-009)", () => {
  const NOW = new Date(2026, 6, 29, 10, 0, 0);

  it("re-stamps a stale entry without throwing when the shard directory is read-only", () => {
    recordDailyCost({ sessionId: "a", costUsd: 1, source: "stdin" }, NOW);
    fs.chmodSync(shardDir(), 0o555);
    try {
      const r = recordDailyCost({ sessionId: "a", costUsd: NaN, source: "stdin" }, NOW);
      expect(r.uncertain).toBe(true);
      expect(r.totalUsd).toBeCloseTo(1);
    } finally {
      fs.chmodSync(shardDir(), 0o755);
    }
  });

  it("does not mark today for an uncertain entry from yesterday", () => {
    recordDailyCost({ sessionId: "a", costUsd: 1, source: "calculated", uncertain: true }, new Date(2026, 6, 28, 22));
    expect(recordDailyCost({ sessionId: "b", costUsd: 2, source: "stdin" }, NOW).uncertain).toBe(false);
  });

  it("marks other sessions when a session's first render could not be recorded", () => {
    recordDailyCost({ sessionId: "a", costUsd: Infinity, source: "calculated" }, NOW);
    const b = recordDailyCost({ sessionId: "b", costUsd: 2, source: "stdin" }, NOW);
    expect(b.totalUsd).toBeCloseTo(2);
    expect(b.uncertain).toBe(true);
  });

  it("keeps a lower-bound mark across a source switch the same day", () => {
    recordDailyCost({ sessionId: "a", costUsd: 0.5, source: "calculated", uncertain: true }, NOW);
    const r = recordDailyCost({ sessionId: "a", costUsd: 0.6, source: "stdin" }, NOW);
    expect(r.uncertain).toBe(true);
  });
});
