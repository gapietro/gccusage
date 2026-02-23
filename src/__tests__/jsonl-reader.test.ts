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
});
