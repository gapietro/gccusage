import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";

interface TurnData {
  sessionId: string;
  count: number;
}

// `JSON.parse("null")` succeeds and yields null, which the old `as TurnData`
// cast then dereferenced outside the try block — throwing, and blanking the
// entire statusline over a four-byte cache file (#92).
const TurnDataSchema = v.object({
  sessionId: v.string(),
  count: v.number(),
});

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
  let data: TurnData = readJsonValidated(filePath, TurnDataSchema) ?? {
    sessionId: "",
    count: 0,
  };

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
