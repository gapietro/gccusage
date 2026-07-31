import * as fs from "node:fs";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface Turn {
  usage: TurnUsage;
  toolNames: string[];
}

export interface ToolResultRecord {
  /** null when the originating tool_use block is not in this file. */
  toolName: string | null;
  bytes: number;
}

export interface SessionRecord {
  sessionId: string;
  turns: Turn[];
  toolResults: ToolResultRecord[];
  userPrompts: number;
  compactBoundaries: number;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one transcript's lines into aggregate counters.
 *
 * A tool result record does not carry the tool's name — only the
 * tool_use_id — so names are resolved from the tool_use blocks seen
 * earlier in the same file. A result whose tool_use is missing is kept
 * with a null name rather than dropped, so byte totals stay complete.
 */
export function parseTranscript(
  lines: Iterable<string>,
  sessionId: string,
): SessionRecord {
  const turns: Turn[] = [];
  const toolResults: ToolResultRecord[] = [];
  const toolNameById = new Map<string, string>();
  let userPrompts = 0;
  let compactBoundaries = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = asRecord(parsed);
    if (!entry) continue;

    const message = asRecord(entry["message"]);
    const content = message ? message["content"] : undefined;

    if (entry["type"] === "assistant") {
      const usage = message ? asRecord(message["usage"]) : null;
      if (!usage) continue;

      const toolNames: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b || b["type"] !== "tool_use") continue;
          const name = typeof b["name"] === "string" ? b["name"] : null;
          const id = typeof b["id"] === "string" ? b["id"] : null;
          if (name) toolNames.push(name);
          if (name && id) toolNameById.set(id, name);
        }
      }

      turns.push({
        usage: {
          inputTokens: num(usage["input_tokens"]),
          outputTokens: num(usage["output_tokens"]),
          cacheReadTokens: num(usage["cache_read_input_tokens"]),
          cacheCreationTokens: num(usage["cache_creation_input_tokens"]),
        },
        toolNames,
      });
      continue;
    }

    if (entry["type"] === "user") {
      if (entry["toolUseResult"] !== undefined && entry["toolUseResult"] !== null) {
        let toolName: string | null = null;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = asRecord(block);
            if (!b || b["type"] !== "tool_result") continue;
            const id = b["tool_use_id"];
            if (typeof id === "string") toolName = toolNameById.get(id) ?? null;
          }
        }
        toolResults.push({
          toolName,
          bytes: JSON.stringify(entry["toolUseResult"]).length,
        });
        continue;
      }

      // A genuine user prompt: not a tool result, not injected context.
      if (entry["isMeta"] !== true) userPrompts += 1;
      continue;
    }

    if (entry["type"] === "system" && entry["subtype"] === "compact_boundary") {
      compactBoundaries += 1;
    }
  }

  return { sessionId, turns, toolResults, userPrompts, compactBoundaries };
}

/**
 * Read a transcript from disk. The largest transcript in the local corpus
 * is 9.4 MB, so whole-file reads are cheap enough to avoid a streaming
 * reader. An unreadable file yields an empty record rather than throwing,
 * so one bad file cannot abort a 644-file sweep.
 */
export function readTranscript(filePath: string, sessionId: string): SessionRecord {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      sessionId,
      turns: [],
      toolResults: [],
      userPrompts: 0,
      compactBoundaries: 0,
    };
  }
  return parseTranscript(text.split("\n"), sessionId);
}
