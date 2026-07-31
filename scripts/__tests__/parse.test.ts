import { describe, it, expect } from "vitest";
import { parseTranscript } from "../lib/parse.ts";

function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe("parseTranscript", () => {
  it("collects usage from assistant turns", () => {
    const record = parseTranscript(
      lines({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 600,
          },
          content: [],
        },
      }),
      "sess-1",
    );

    expect(record.sessionId).toBe("sess-1");
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]!.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5000,
      cacheCreationTokens: 600,
    });
  });

  it("defaults missing usage fields to zero", () => {
    const record = parseTranscript(
      lines({ type: "assistant", message: { usage: { input_tokens: 7 } } }),
      "sess-1",
    );
    expect(record.turns[0]!.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("skips assistant records with no usage object", () => {
    const record = parseTranscript(
      lines({ type: "assistant", message: { content: [] } }),
      "sess-1",
    );
    expect(record.turns).toHaveLength(0);
  });

  it("records tool names used in a turn", () => {
    const record = parseTranscript(
      lines({
        type: "assistant",
        message: {
          usage: { input_tokens: 1 },
          content: [
            { type: "text", text: "ignored" },
            { type: "tool_use", id: "toolu_1", name: "Bash" },
            { type: "tool_use", id: "toolu_2", name: "Edit" },
          ],
        },
      }),
      "sess-1",
    );
    expect(record.turns[0]!.toolNames).toEqual(["Bash", "Edit"]);
  });

  it("attributes a tool result to the tool that produced it", () => {
    const record = parseTranscript(
      lines(
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 1 },
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
          },
        },
        {
          type: "user",
          toolUseResult: { stdout: "hello" },
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
        },
      ),
      "sess-1",
    );

    expect(record.toolResults).toHaveLength(1);
    expect(record.toolResults[0]!.toolName).toBe("Bash");
    expect(record.toolResults[0]!.bytes).toBe(
      JSON.stringify({ stdout: "hello" }).length,
    );
  });

  it("measures result size in UTF-8 bytes, not UTF-16 code units", () => {
    const record = parseTranscript(
      lines({
        type: "user",
        toolUseResult: "你好",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
      }),
      "sess-1",
    );

    // Two CJK characters plus two quotes: 2 string chars but 6 UTF-8 bytes, plus 2.
    expect(record.toolResults[0]!.bytes).toBe(8);
    expect(record.toolResults[0]!.bytes).not.toBe(
      JSON.stringify("你好").length,
    );
  });

  it("records an unattributable tool result with a null tool name", () => {
    const record = parseTranscript(
      lines({
        type: "user",
        toolUseResult: "orphan",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_missing" }] },
      }),
      "sess-1",
    );
    expect(record.toolResults[0]!.toolName).toBeNull();
  });

  it("counts real user prompts but not tool results or meta records", () => {
    const record = parseTranscript(
      lines(
        { type: "user", message: { content: "a real prompt" } },
        { type: "user", isMeta: true, message: { content: "injected context" } },
        {
          type: "user",
          toolUseResult: "x",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
        },
      ),
      "sess-1",
    );
    expect(record.userPrompts).toBe(1);
  });

  it("counts compact boundaries", () => {
    const record = parseTranscript(
      lines(
        { type: "system", subtype: "compact_boundary" },
        { type: "system", subtype: "turn_duration" },
      ),
      "sess-1",
    );
    expect(record.compactBoundaries).toBe(1);
  });

  it("ignores malformed lines instead of throwing", () => {
    const record = parseTranscript(
      ["not json at all", "", JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3 } } })],
      "sess-1",
    );
    expect(record.turns).toHaveLength(1);
  });
});
