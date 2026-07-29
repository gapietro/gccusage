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

export function parseJsonlContent(content: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      entries.push(normalizeEntry(parsed));
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
