import * as fs from "node:fs";

export interface JsonlEntry {
  type?: string;
  model?: string;
  costUsd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    /**
     * The SUBSET of `cache_creation_input_tokens` written with the 1-hour TTL,
     * flattened out of the transcript's nested `cache_creation` object and
     * clamped to the flat total. 5-minute tokens are the difference (#118).
     */
    cache_creation_1h_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  timestamp?: string;
  sessionId?: string;
}

export function parseJsonlFile(filePath: string): JsonlEntry[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseJsonlContent(content);
  } catch {
    return [];
  }
}

/**
 * Parse a transcript's lines into entries, one per API response.
 *
 * Claude Code writes one line per content block — a response with a
 * `thinking` block, a `text` block and two `tool_use` blocks is four
 * `type: "assistant"` lines — all sharing a single `message.id`. Counting
 * lines therefore over-counts tokens by roughly 2.1x on a real corpus, and
 * does so non-uniformly: responses with more content blocks weigh more, so
 * it is not a constant factor that cancels out downstream.
 *
 * The `usage` object is *not* byte-identical across a group's lines. Two
 * transcript formats exist in the wild: main session transcripts repeat the
 * same usage on every line, while subagent transcripts grow `output_tokens`
 * line by line as the response streams. Across a 14,063-group corpus,
 * `output_tokens` is monotonically non-decreasing within a group (0
 * non-monotonic groups) and the **last** line carries the maximum in every
 * single group. The last line is therefore authoritative, and we keep its
 * usage rather than the first line's.
 *
 * Only `usage` is taken from the later line. The group's other fields —
 * `timestamp`, `costUsd`, `sessionId`, `model` — stay as the *first* line
 * set them, which keeps `filterTodayEntries` bucketing a response by when it
 * started. (Those fields are stable within a group anyway: `input_tokens`
 * and the cache fields differ in only 2 of 14,063 groups.)
 *
 * The gate is narrow on purpose. A line is merged into an earlier entry only
 * when it has a `message.id`, carries usage, and that id has been seen.
 * Entries without a `message.id` stay separate: the legacy flat format has no
 * `message` wrapper and was never split across lines. Entries without usage
 * stay too, so nothing reading `costUsd`, `timestamp` or `sessionId` is
 * affected.
 */
export function parseJsonlContent(content: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  const entryIndexByMessageId = new Map<string, number>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const entry = normalizeEntry(parsed);

      if (entry.usage) {
        const message =
          typeof parsed["message"] === "object" && parsed["message"] !== null
            ? (parsed["message"] as Record<string, unknown>)
            : undefined;
        const messageId = typeof message?.["id"] === "string" ? message["id"] : null;

        if (messageId !== null) {
          const existingIndex = entryIndexByMessageId.get(messageId);
          if (existingIndex !== undefined) {
            // Later line of the same response: its usage supersedes, the
            // first line's other fields stand.
            entries[existingIndex]!.usage = entry.usage;
            continue;
          }
          entryIndexByMessageId.set(messageId, entries.length);
        }
      }

      entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function normalizeEntry(raw: Record<string, unknown>): JsonlEntry {
  const entry: JsonlEntry = {};

  if (typeof raw["type"] === "string") entry.type = raw["type"];
  if (typeof raw["costUsd"] === "number") entry.costUsd = raw["costUsd"];
  if (typeof raw["timestamp"] === "string") entry.timestamp = raw["timestamp"];
  if (typeof raw["sessionId"] === "string") entry.sessionId = raw["sessionId"];

  // Current Claude Code transcripts nest model/usage under `message`;
  // the legacy flat format keeps them at the top level.
  const message =
    typeof raw["message"] === "object" && raw["message"] !== null
      ? (raw["message"] as Record<string, unknown>)
      : undefined;
  const model = message?.["model"] ?? raw["model"];
  const usage = (message?.["usage"] ?? raw["usage"]) as Record<string, unknown> | undefined;

  if (typeof model === "string") entry.model = model;

  if (usage && typeof usage === "object") {
    const cacheCreation =
      typeof usage["cache_creation"] === "object" && usage["cache_creation"] !== null
        ? (usage["cache_creation"] as Record<string, unknown>)
        : undefined;
    const flatCacheCreation =
      typeof usage["cache_creation_input_tokens"] === "number"
        ? usage["cache_creation_input_tokens"]
        : 0;
    const raw1h = cacheCreation?.["ephemeral_1h_input_tokens"];
    // Clamped so the subset invariant holds no matter what the file says:
    // calculateCost subtracts to get the 5-minute bucket, and a negative
    // bucket would silently UNDER-count. Never observed in real transcripts.
    const cacheCreation1h =
      typeof raw1h === "number" && raw1h > 0 ? Math.min(raw1h, flatCacheCreation) : 0;

    entry.usage = {
      input_tokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : undefined,
      output_tokens:
        typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : undefined,
      cache_creation_input_tokens:
        typeof usage["cache_creation_input_tokens"] === "number"
          ? usage["cache_creation_input_tokens"]
          : undefined,
      cache_creation_1h_input_tokens: cacheCreation1h,
      cache_read_input_tokens:
        typeof usage["cache_read_input_tokens"] === "number"
          ? usage["cache_read_input_tokens"]
          : undefined,
    };
  }

  return entry;
}

export function isEntryFromToday(entry: JsonlEntry, now: Date = new Date()): boolean {
  if (!entry.timestamp) return false;
  const ts = new Date(entry.timestamp).getTime();
  if (Number.isNaN(ts)) return false;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return ts >= midnight.getTime();
}

export function filterTodayEntries(entries: JsonlEntry[], now: Date = new Date()): JsonlEntry[] {
  return entries.filter((e) => isEntryFromToday(e, now));
}
