import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

export type CostSource = "stdin" | "calculated";

interface DailyCostEntry {
  sessionId: string;
  costUsd: number; // latest cumulative session cost
  baselineUsd: number; // cumulative cost at the start of today
  source?: CostSource; // where costUsd came from (absent in legacy files)
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
  source: CostSource,
  now: Date = new Date(),
): number {
  const data = readDailyCostFile(now);

  if (sessionId) {
    const existing = data.sessions.find((s) => s.sessionId === sessionId);
    if (existing) {
      const accruedToday = Math.max(0, existing.costUsd - existing.baselineUsd);
      if (existing.source !== undefined && existing.source !== source) {
        // Stdin and JSONL-calculated costs use different scales, so a drop
        // across a source switch is not a restart. Re-baseline so today's
        // accrued spend carries over unchanged into the new scale.
        existing.baselineUsd = costUsd - accruedToday;
      } else if (costUsd < existing.costUsd) {
        // A restarted session reuses the ID with a reset cumulative cost
        // (cumulative cost never decreases within one process). Fold the
        // already-accrued today delta into the baseline (as a negative
        // offset) so prior spend since midnight is preserved.
        existing.baselineUsd = -accruedToday;
      }
      existing.costUsd = costUsd;
      existing.source = source;
      existing.updatedAt = now.getTime();
    } else {
      data.sessions.push({
        sessionId,
        costUsd,
        baselineUsd: 0,
        source,
        updatedAt: now.getTime(),
      });
    }
    writeDailyCostFile(data);
  }

  let total = 0;
  for (const s of data.sessions) {
    total += Math.max(0, s.costUsd - s.baselineUsd);
  }
  return total;
}
