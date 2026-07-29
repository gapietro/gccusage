import { describe, it, expect } from "vitest";
import { parseJsonlContent } from "../data/jsonl-reader.js";

describe("parseJsonlContent", () => {
  it("parses valid lines", () => {
    const content = [
      '{"type":"request","model":"claude-sonnet-4-20250514","usage":{"input_tokens":1000,"output_tokens":500}}',
      '{"type":"response","model":"claude-sonnet-4-20250514","usage":{"input_tokens":2000,"output_tokens":800}}',
    ].join("\n");

    const entries = parseJsonlContent(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.model).toBe("claude-sonnet-4-20250514");
    expect(entries[0]!.usage?.input_tokens).toBe(1000);
    expect(entries[1]!.usage?.output_tokens).toBe(800);
  });

  it("skips malformed lines", () => {
    const content = '{"valid":true}\nnot json\n{"also":"valid"}';
    const entries = parseJsonlContent(content);
    expect(entries).toHaveLength(2);
  });

  it("handles empty content", () => {
    expect(parseJsonlContent("")).toHaveLength(0);
    expect(parseJsonlContent("  \n  ")).toHaveLength(0);
  });

  it("parses the current nested assistant-message format", () => {
    const content = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-29T21:12:56.795Z",
      sessionId: "9bf0e129-639d-42db-b309-be89527c75d9",
      message: {
        model: "claude-fable-5",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 22228,
          cache_read_input_tokens: 20554,
          output_tokens: 468,
          service_tier: "standard",
        },
      },
    });

    const entries = parseJsonlContent(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("assistant");
    expect(entries[0]!.model).toBe("claude-fable-5");
    expect(entries[0]!.timestamp).toBe("2026-07-29T21:12:56.795Z");
    expect(entries[0]!.sessionId).toBe("9bf0e129-639d-42db-b309-be89527c75d9");
    expect(entries[0]!.usage).toEqual({
      input_tokens: 2,
      output_tokens: 468,
      cache_creation_input_tokens: 22228,
      cache_read_input_tokens: 20554,
    });
  });

  it("ignores a non-object message field", () => {
    const entries = parseJsonlContent('{"type":"assistant","message":"oops"}');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.model).toBeUndefined();
    expect(entries[0]!.usage).toBeUndefined();
  });
});
