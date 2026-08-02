import * as fs from "node:fs";
import * as path from "node:path";
import { getCacheDir } from "../utils/paths.js";
import { writeJsonAtomic } from "../utils/atomic-json.js";

interface TurnData {
  sessionId: string;
  count: number;
}

function getTurnPath(): string {
  return path.join(getCacheDir(), "turn-count.json");
}

/**
 * Increment and return the turn count for the given session.
 * Resets when session ID changes.
 */
export function trackTurn(sessionId: string | undefined): number {
  if (!sessionId) return 0;

  const filePath = getTurnPath();
  let data: TurnData = { sessionId: "", count: 0 };

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    data = JSON.parse(raw) as TurnData;
  } catch {
    // File doesn't exist or is invalid
  }

  // Reset if different session
  if (data.sessionId !== sessionId) {
    data = { sessionId, count: 0 };
  }

  data.count++;

  // Atomic replacement, but deliberately no lock: the counter already resets
  // whenever the session id changes, so an increment lost between two
  // concurrent sessions is indistinguishable from that designed behaviour.
  writeJsonAtomic(filePath, data);

  return data.count;
}
