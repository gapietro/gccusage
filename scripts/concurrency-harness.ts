/**
 * Reproduction harness for issue #81 (REL-001).
 *
 * Spawns N concurrent renders of the shipped bundle, each with a distinct
 * session id, over R rounds against an isolated XDG_CACHE_HOME. Every round
 * must find all N sessions in the daily store and total exactly
 * N x (round x COST_STEP); a smaller total is a lost update.
 *
 * The cumulative cost grows by COST_STEP each round. That is load-bearing: the
 * statusline cache keys on (session, cost, width), so a fixed cost would make
 * every round after the first a cache hit that never reaches the tracker, and
 * the harness would measure nothing while printing all-ok.
 *
 * Usage: node scripts/concurrency-harness.ts [--sessions 12] [--rounds 8]
 *
 * It drives `dist/index.js` rather than importing `src/` because scripts/ runs
 * directly under Node, where a `.js` specifier pointing at a `.ts` file throws
 * ERR_MODULE_NOT_FOUND. Run `npm run build` first.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const COST_STEP = 10;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(repoRoot, "dist", "index.js");

function intArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} needs a positive integer`);
  }
  return value;
}

function render(sessionId: string, costUsd: number, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", () => resolve());
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        cost: { total_cost_usd: costUsd },
        model: { id: "claude-opus-5", display_name: "Opus 5" },
        workspace: { current_dir: repoRoot, project_dir: repoRoot },
      }),
    );
  });
}

function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

interface StoreState {
  sessions: number;
  total: number;
}

/** Today's total as the tracker computes it, from whichever layout is on disk. */
function readStore(cacheHome: string): StoreState {
  const cacheDir = path.join(cacheHome, "gccusage");
  const today = localToday();

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

  // Pre-shard layout, so the harness also runs against the old bundle.
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

async function main(): Promise<void> {
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`${bundlePath} is missing — run \`npm run build\` first`);
  }

  const sessionCount = intArg("--sessions", 12);
  const rounds = intArg("--rounds", 8);


  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-concurrency-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpDir, // no transcripts, no user settings
    XDG_CACHE_HOME: tmpDir,
  };

  console.log(
    `${sessionCount} concurrent sessions x ${rounds} rounds, ` +
      `+$${COST_STEP.toFixed(2)} per session per round`,
  );

  let failures = 0;
  try {
    for (let round = 1; round <= rounds; round++) {
      const costThisRound = round * COST_STEP;
      const expected = sessionCount * costThisRound;
      await Promise.all(
        Array.from({ length: sessionCount }, (_, i) =>
          render(`session-${i}`, costThisRound, env),
        ),
      );

      const { sessions, total } = readStore(tmpDir);
      const ok = Math.abs(total - expected) < 0.005 && sessions === sessionCount;
      if (!ok) failures++;
      console.log(
        `round ${String(round).padStart(2)}: ` +
          `${String(sessions).padStart(3)} sessions, ` +
          `$${total.toFixed(2).padStart(9)} of $${expected.toFixed(2).padStart(9)}` +
          `  ${ok ? "ok" : "*** LOST UPDATE ***"}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`rounds with lost updates: ${failures} / ${rounds}`);
  if (failures > 0) process.exitCode = 1;
}

await main();
