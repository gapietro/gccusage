import * as v from "valibot";
import { StatusJsonSchema, type StatusJson } from "../types/status-json.js";

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      resolve("");
    }, 1000);

    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    process.stdin.resume();
  });
}

export interface StdinParseResult {
  stdin: StatusJson;
  /** Set only when the payload is unusable as a whole, never for a bad field. */
  error?: string;
}

/**
 * Individual bad fields are absorbed by the schema (see status-json.ts), so
 * an error here means the payload was not a usable object at all. That is
 * worth showing rather than swallowing: the old behaviour rendered a
 * confident `$0.00` bar from `{}`, which reads as real data (#83).
 *
 * Empty input is NOT an error — it is the ordinary case for a TTY or a
 * read that timed out, and flagging it would put a red line in front of
 * everyone who runs the binary by hand.
 */
export function parseStatusJson(raw: string): StdinParseResult {
  if (!raw.trim()) return { stdin: {} };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "could not be parsed";
    return { stdin: {}, error: `stdin is not valid JSON — ${detail}` };
  }

  // valibot's object schema accepts an array and yields {}, so an array would
  // otherwise degrade silently to an empty bar rather than being reported.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { stdin: {}, error: `stdin is ${describe(data)}, expected a JSON object` };
  }

  try {
    return { stdin: v.parse(StatusJsonSchema, data) };
  } catch {
    // Unreachable for field-level problems; kept so an unforeseen schema
    // failure degrades to a reported error instead of an exception.
    return { stdin: {}, error: "stdin did not match the expected shape" };
  }
}

function describe(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return "an array";
  return `a ${typeof data}`;
}
