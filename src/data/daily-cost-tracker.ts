import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir, ensureDir } from "../utils/paths.js";

interface DailyCostEntry {
  sessionId: string;
  costUsd: number;
  updatedAt: number;
}

interface DailyCostFile {
  date: string;
  sessions: DailyCostEntry[];
}

function getDailyCostPath(): string {
  return path.join(getCacheDir(), "daily-costs.json");
}

function todayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readDailyCostFile(): DailyCostFile {
  const filePath = getDailyCostPath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as DailyCostFile;
    // Reset if it's a new day
    if (data.date !== todayDateStr()) {
      return { date: todayDateStr(), sessions: [] };
    }
    return data;
  } catch {
    return { date: todayDateStr(), sessions: [] };
  }
}

function writeDailyCostFile(data: DailyCostFile): void {
  const filePath = getDailyCostPath();
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

/**
 * Record the current session's cost and return today's total across all sessions.
 */
export function trackDailyCost(sessionId: string | undefined, costUsd: number): number {
  const data = readDailyCostFile();

  if (sessionId) {
    const existing = data.sessions.find((s) => s.sessionId === sessionId);
    if (existing) {
      existing.costUsd = costUsd;
      existing.updatedAt = Date.now();
    } else {
      data.sessions.push({ sessionId, costUsd, updatedAt: Date.now() });
    }
    writeDailyCostFile(data);
  }

  let total = 0;
  for (const s of data.sessions) {
    total += s.costUsd;
  }
  return total;
}
