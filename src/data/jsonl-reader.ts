import * as fs from "node:fs";

export interface JsonlEntry {
  type?: string;
  model?: string;
  costUsd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
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
 * `type: "assistant"` lines — and repeats a byte-identical `message.usage`
 * on every one of them. Counting lines therefore over-counts tokens by
 * roughly 2.1x on a real corpus, and does so non-uniformly: responses with
 * more content blocks weigh more, so it is not a constant factor that
 * cancels out downstream.
 *
 * The gate is narrow on purpose. A line is dropped only when it has a
 * `message.id`, carries usage, and that id has been seen. Entries without a
 * `message.id` stay separate: the legacy flat format has no `message`
 * wrapper and was never split across lines. Entries without usage stay too,
 * so nothing reading `costUsd`, `timestamp` or `sessionId` is affected.
 */
export function parseJsonlContent(content: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  const seenMessageIds = new Set<string>();

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
          if (seenMessageIds.has(messageId)) continue;
          seenMessageIds.add(messageId);
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
    entry.usage = {
      input_tokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : undefined,
      output_tokens:
        typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : undefined,
      cache_creation_input_tokens:
        typeof usage["cache_creation_input_tokens"] === "number"
          ? usage["cache_creation_input_tokens"]
          : undefined,
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
