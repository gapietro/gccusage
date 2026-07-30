import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

interface DailyCostEntry {
  sessionId: string;
  costUsd: number; // latest cumulative session cost
  baselineUsd: number; // cumulative cost at the start of today
  updatedAt: number;
}

interface DailyCostFile {
  date: string;
  sessions: DailyCostEntry[];
}

function getDailyCostPath(): string {
  return path.join(getCacheDir(), "daily-costs.json");
}

function dateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const STALE_SESSION_MS = 48 * 3600 * 1000;

function readDailyCostFile(now: Date): DailyCostFile {
  const filePath = getDailyCostPath();
  const today = dateStr(now);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as DailyCostFile;
    const sessions = (data.sessions ?? []).map((s) => ({
      ...s,
      baselineUsd: typeof s.baselineUsd === "number" ? s.baselineUsd : 0,
    }));
    if (data.date !== today) {
      // New day: carry sessions forward, resetting their baseline to the
      // last cumulative cost so only post-midnight spend counts as today's.
      return {
        date: today,
        sessions: sessions
          .filter((s) => now.getTime() - s.updatedAt < STALE_SESSION_MS)
          .map((s) => ({ ...s, baselineUsd: s.costUsd })),
      };
    }
    return { date: today, sessions };
  } catch {
    return { date: today, sessions: [] };
  }
}

function writeDailyCostFile(data: DailyCostFile): void {
  const filePath = getDailyCostPath();
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

/**
 * Record the current session's cumulative cost and return today's total
 * across all sessions (spend since local midnight only).
 */
export function trackDailyCost(
  sessionId: string | undefined,
  costUsd: number,
  now: Date = new Date(),
): number {
  const data = readDailyCostFile(now);

  if (sessionId) {
    const existing = data.sessions.find((s) => s.sessionId === sessionId);
    if (existing) {
      existing.costUsd = costUsd;
      // A restarted session reuses the ID with a reset cumulative cost;
      // keep the baseline consistent so the delta never goes negative.
      if (costUsd < existing.baselineUsd) existing.baselineUsd = 0;
      existing.updatedAt = now.getTime();
    } else {
      data.sessions.push({ sessionId, costUsd, baselineUsd: 0, updatedAt: now.getTime() });
    }
    writeDailyCostFile(data);
  }

  let total = 0;
  for (const s of data.sessions) {
    total += Math.max(0, s.costUsd - s.baselineUsd);
  }
  return total;
}
