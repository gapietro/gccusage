import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reserveRefusedUrl,
  suppressPricingRefresh,
  type RefresherSuppression,
} from "./helpers/pricing-refresher.js";

/**
 * REL-001 — concurrent renders losing daily-cost updates — reached production
 * because nothing in the suite ever ran two renders at once (#95). It was
 * fixed in PR #101 and has a reproduction harness in
 * `scripts/concurrency-harness.ts`, but a harness nobody runs is not a guard:
 * only a test in the suite fails a PR that reintroduces the bug.
 *
 * This is the harness scaled down to what CI can afford. It spawns the real
 * shipped bundle rather than calling the tracker in-process, because the
 * defect was a lost update BETWEEN processes — an in-process test shares one
 * event loop and cannot observe it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const REPO_ROOT = path.resolve(HERE, "../..");
const distExists = fs.existsSync(DIST);

const SESSIONS = 8;
const ROUNDS = 3;
const COST_STEP = 0.25;

let dir: string;
let refusedPricingUrl: string;
let refresher: RefresherSuppression;

beforeAll(async () => {
  refusedPricingUrl = await reserveRefusedUrl();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-concurrency-"));
  // XDG_CACHE_HOME is the temp dir itself here, not a `cache/` subdirectory
  // as in the stdin and width tests — which is exactly why the helper takes
  // the value the caller passes to the child rather than deriving one.
  refresher = suppressPricingRefresh(dir, refusedPricingUrl);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});


function render(sessionId: string, costUsd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST], {
      // HOME isolates it from the user's transcripts and settings;
      // XDG_CACHE_HOME isolates the daily store this test is measuring.
      env: {
        ...process.env,
        HOME: dir,
        ...refresher.env,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", () => resolve());
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        cost: { total_cost_usd: costUsd },
        model: { id: "claude-opus-5", display_name: "Opus 5" },
        workspace: { current_dir: REPO_ROOT, project_dir: REPO_ROOT },
      }),
    );
  });
}

/** The local date, matching how the tracker stamps a shard. */
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Today's total as the tracker computes it, from whichever layout is on disk.
 *
 * The pre-shard single-file layout is read too, and that is load-bearing for
 * this test rather than legacy tolerance: it is what makes a failure say
 * "$6.00 of $8.00, four sessions lost" instead of "no shard directory". A
 * reader that only understands shards would fail a revert for the wrong
 * reason — on the directory name — and would keep passing if someone
 * consolidated the shards back into one read-modify-write file under the
 * current name, which is precisely REL-001 returning.
 */
function readStore(): { sessions: number; total: number } {
  const today = localToday();
  const cacheDir = path.join(dir, "gccusage");

  const shardDir = path.join(cacheDir, "daily");
  if (fs.existsSync(shardDir)) {
    let sessions = 0;
    let total = 0;
    for (const file of fs.readdirSync(shardDir)) {
      if (!file.endsWith(".json")) continue;
      let entry: { date?: string; costUsd?: number; baselineUsd?: number };
      try {
        entry = JSON.parse(fs.readFileSync(path.join(shardDir, file), "utf-8"));
      } catch {
        continue; // A torn file counts as a lost session, not a crash.
      }
      if (typeof entry.costUsd !== "number" || entry.date !== today) continue;
      sessions++;
      total += Math.max(0, entry.costUsd - (entry.baselineUsd ?? 0));
    }
    return { sessions, total };
  }

  const legacyPath = path.join(cacheDir, "daily-costs.json");
  if (!fs.existsSync(legacyPath)) return { sessions: 0, total: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
    if (data.date !== today) return { sessions: 0, total: 0 };
    const entries: { costUsd?: number; baselineUsd?: number }[] = data.sessions ?? [];
    return {
      sessions: entries.length,
      total: entries.reduce(
        (sum, s) => sum + Math.max(0, (s.costUsd ?? 0) - (s.baselineUsd ?? 0)),
        0,
      ),
    };
  } catch {
    return { sessions: 0, total: 0 };
  }
}

describe.skipIf(!distExists)("concurrent renders", () => {
  it("loses no daily-cost updates across concurrent sessions", async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      // The cost MUST grow each round. The statusline cache keys on the whole
      // stdin payload, so a fixed cost would make every round after the first
      // a cache hit that never reaches the tracker — the test would measure
      // nothing while passing.
      const costThisRound = round * COST_STEP;

      await Promise.all(
        Array.from({ length: SESSIONS }, (_, i) => render(`session-${i}`, costThisRound)),
      );

      const { sessions, total } = readStore();

      expect(sessions, `round ${round}: sessions lost from the daily store`).toBe(SESSIONS);
      expect(total, `round ${round}: lost update`).toBeCloseTo(SESSIONS * costThisRound, 2);
    }

    refresher.assertNotSpawned();
  }, 120_000);

  it("keeps one session's spend out of another's shard", async () => {
    // Per-session shards are what make the concurrent case safe, so the
    // partitioning itself is worth pinning: a single shared file would pass
    // the total assertion above while attributing every dollar to one session.
    await Promise.all([render("alpha", 1), render("beta", 3)]);

    const shardDir = path.join(dir, "gccusage", "daily");
    const shards = fs
      .readdirSync(shardDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(shardDir, f), "utf-8")));

    expect(shards).toHaveLength(2);
    expect(shards.map((s) => s.costUsd).sort((a, b) => a - b)).toEqual([1, 3]);

    refresher.assertNotSpawned();
  }, 60_000);
});
