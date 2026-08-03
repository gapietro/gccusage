import * as v from "valibot";
import type { Readable } from "node:stream";
import { StatusJsonSchema, type StatusJson } from "../types/status-json.js";

/**
 * Claude Code waits 600s for the statusline command (its hook spawn helper
 * computes `e.timeout ? e.timeout*1000 : 600000`, verified against the 2.1.220
 * binary), so nothing external pressured the old 1s deadline — we chose it, and
 * it was the only binding constraint. Claude Code also writes the payload and
 * immediately `end()`s stdin, so a read still incomplete after 5s is pathology
 * rather than a merely loaded machine (#87).
 */
export const DEFAULT_STDIN_TIMEOUT_MS = 5000;

/**
 * Overridable so tests can drive the real bundle at a deadline short enough to
 * keep, following the precedent of `GCCUSAGE_PRICING_URL` (PR #106).
 *
 * A malformed value degrades to the default rather than being coerced: a NaN
 * deadline makes `setTimeout` fire immediately, which would turn every render
 * into the degraded line. The same failure is reachable from the OTHER end of
 * the range — `setTimeout`'s delay is capped at 2^31-1 ms; past that, Node
 * emits `TimeoutOverflowWarning` on stderr (invisible in statusline mode) and
 * silently clamps the delay to 1ms, so an oversized value degrades exactly
 * like a NaN one: every render times out immediately. Both ends are rejected
 * by the same clause.
 */
export function resolveTimeoutMs(): number {
  const raw = process.env["GCCUSAGE_STDIN_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STDIN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    return DEFAULT_STDIN_TIMEOUT_MS;
  }
  return parsed;
}

export interface StdinReadResult {
  raw: string;
  /** True when the deadline expired. Never conflate with an empty `raw`. */
  timedOut: boolean;
  /** The deadline actually applied, so the caller can name it in a message. */
  timeoutMs: number;
}

/**
 * The old signature resolved `""` on timeout, which the caller could not tell
 * from "Claude Code sent nothing" — so a slow payload rendered a confident
 * $0.00 bar beside a non-zero `Today:` read from the daily store (#87).
 *
 * Both parameters exist for the tests; production has exactly one call site
 * (`src/index.ts`) and passes neither.
 */
export function readStdin(
  stream: Readable = process.stdin,
  timeoutMs: number = resolveTimeoutMs(),
): Promise<StdinReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        raw: Buffer.concat(chunks).toString("utf-8"),
        timedOut,
        timeoutMs,
      });
    };

    timer = setTimeout(() => {
      // Settle before destroying, not after: destroy() can emit synchronously,
      // and `settled` must already be true when those events land so a late
      // error cannot reject a promise we have decided to fulfil. The destroy
      // itself stays — the process cannot exit while it holds a live stdin,
      // and Claude Code waits for exit.
      settle(true);
      stream.destroy();
    }, timeoutMs);

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => settle(false));
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    stream.resume();
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
