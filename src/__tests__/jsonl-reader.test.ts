import { describe, it, expect } from "vitest";
import { parseJsonlContent, filterTodayEntries } from "../data/jsonl-reader.js";

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
      cache_creation_1h_input_tokens: 0,
      cache_read_input_tokens: 20554,
    });
  });

  it("ignores a non-object message field", () => {
    const entries = parseJsonlContent('{"type":"assistant","message":"oops"}');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.model).toBeUndefined();
    expect(entries[0]!.usage).toBeUndefined();
  });

  it("counts one entry per message.id, keeping the last line's usage", () => {
    // Claude Code splits one API response across a line per content block.
    // Counting lines double-counts tokens, and does it non-uniformly:
    // responses with more blocks weigh more. The lines do not necessarily
    // repeat one usage object — subagent transcripts grow `output_tokens` as
    // the response streams, and the final line carries the true total.
    const usage = (output: number) =>
      `"usage":{"input_tokens":2,"output_tokens":${output},"cache_read_input_tokens":20233}`;
    const content = [
      `{"type":"assistant","message":{"id":"msg_01","model":"claude-opus-4-6",${usage(5)},"content":[{"type":"thinking"}]}}`,
      `{"type":"assistant","message":{"id":"msg_01","model":"claude-opus-4-6",${usage(107)},"content":[{"type":"text"}]}}`,
      `{"type":"assistant","message":{"id":"msg_01","model":"claude-opus-4-6",${usage(296)},"content":[{"type":"tool_use"}]}}`,
    ].join("\n");

    const entries = parseJsonlContent(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.usage?.output_tokens).toBe(296);
  });

  it("keeps the first line's non-usage fields when merging a group", () => {
    // Only `usage` comes from the later line. Keeping the first line's
    // timestamp is what makes filterTodayEntries bucket a response by when
    // it started.
    const content = [
      '{"type":"assistant","timestamp":"2026-07-29T21:12:56.795Z","sessionId":"sess-a","costUsd":0.25,"message":{"id":"msg_01","model":"claude-opus-4-6","usage":{"output_tokens":5}}}',
      '{"type":"assistant","timestamp":"2026-07-29T21:13:04.100Z","sessionId":"sess-a","costUsd":0.40,"message":{"id":"msg_01","model":"claude-opus-4-6","usage":{"output_tokens":296}}}',
    ].join("\n");

    const entries = parseJsonlContent(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.timestamp).toBe("2026-07-29T21:12:56.795Z");
    expect(entries[0]!.costUsd).toBe(0.25);
    expect(entries[0]!.usage?.output_tokens).toBe(296);
  });

  it("keeps distinct message ids as separate entries", () => {
    const usage = '"usage":{"input_tokens":10,"output_tokens":20}';
    const content = [
      `{"type":"assistant","message":{"id":"msg_01",${usage}}}`,
      `{"type":"assistant","message":{"id":"msg_02",${usage}}}`,
    ].join("\n");

    expect(parseJsonlContent(content)).toHaveLength(2);
  });

  it("keeps usage-bearing entries that carry no message id", () => {
    // The legacy flat format has no `message` wrapper and was never split
    // across lines, so it must not be collapsed.
    const content = [
      '{"type":"response","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100}}',
      '{"type":"response","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100}}',
    ].join("\n");

    expect(parseJsonlContent(content)).toHaveLength(2);
  });

  it("leaves lines that carry no usage alone", () => {
    // Only token sums are at risk from duplication. A repeated id on a
    // usage-free line must not suppress costUsd or timestamp data.
    const content = [
      '{"type":"assistant","message":{"id":"msg_01"},"costUsd":0.25}',
      '{"type":"assistant","message":{"id":"msg_01"},"costUsd":0.25}',
    ].join("\n");

    expect(parseJsonlContent(content)).toHaveLength(2);
  });
});

describe("filterTodayEntries", () => {
  it("keeps only entries stamped on or after local midnight", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0); // 2026-07-29 10:00 local
    const midnight = new Date(2026, 6, 29, 0, 0, 0);
    const yesterday = new Date(2026, 6, 28, 23, 59, 0);

    const entries = [
      { timestamp: yesterday.toISOString(), usage: { input_tokens: 1 } },
      { timestamp: midnight.toISOString(), usage: { input_tokens: 2 } },
      { timestamp: now.toISOString(), usage: { input_tokens: 3 } },
    ];

    const filtered = filterTodayEntries(entries, now);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]!.usage?.input_tokens).toBe(2);
    expect(filtered[1]!.usage?.input_tokens).toBe(3);
  });

  it("drops entries without a parseable timestamp", () => {
    const now = new Date(2026, 6, 29, 10, 0, 0);
    const entries = [
      { usage: { input_tokens: 1 } },
      { timestamp: "not-a-date", usage: { input_tokens: 2 } },
    ];
    expect(filterTodayEntries(entries, now)).toHaveLength(0);
  });
});

describe("1-hour cache creation tokens", () => {
  it("reads the ephemeral_1h count out of the nested breakdown", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-03T10:00:00Z",
        message: {
          id: "msg_1",
          model: "claude-opus-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 500,
            cache_creation: {
              ephemeral_5m_input_tokens: 400,
              ephemeral_1h_input_tokens: 600,
            },
          },
        },
      }),
    );
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(600);
    // The flat total is untouched — the 1h count is a SUBSET of it, not a sibling.
    expect(entries[0]!.usage!.cache_creation_input_tokens).toBe(1000);
  });

  it("treats a missing cache_creation object as all 5-minute", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_2",
          model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1000 },
        },
      }),
    );
    // Honest default: transcripts predating the breakdown predate 1h caching.
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(0);
  });

  // SYNTHETIC CORRUPTION — this shape does NOT occur in real transcripts
  // (0 occurrences across 98,722 usage-bearing lines). It guards the subset
  // invariant only: calculateCost derives the 5-minute bucket by subtraction,
  // so an unclamped overshoot would yield a NEGATIVE bucket and a cost below
  // the truth. Do not read this as a real-world case.
  it("clamps a 1-hour count that exceeds the flat total", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_3",
          model: "claude-opus-5",
          usage: {
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: 500 },
          },
        },
      }),
    );
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(100);
  });

  // SYNTHETIC CORRUPTION, same as above. Guards the `raw1h > 0` guard in
  // normalizeEntry (#118 review, M1): relaxing it to `typeof raw1h ===
  // "number"` would let a negative count through Math.min unclamped, handing
  // calculateCost a negative 1-hour bucket that over-charges the 5-minute
  // remainder and negates the 1-hour term.
  it("treats a negative ephemeral_1h count as zero", () => {
    const entries = parseJsonlContent(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_4",
          model: "claude-opus-5",
          usage: {
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: -50 },
          },
        },
      }),
    );
    expect(entries[0]!.usage!.cache_creation_1h_input_tokens).toBe(0);
  });
});
