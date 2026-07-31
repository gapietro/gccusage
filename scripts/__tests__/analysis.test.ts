import { describe, it, expect } from "vitest";
import type { SessionRecord } from "../lib/parse.ts";
import {
  MIN_TURNS,
  sessionMetrics,
  pearson,
  toolProfiles,
  compareDelegation,
  scoreSignals,
  normaliseToolName,
} from "../lib/analysis.ts";

function turn(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  toolNames: string[] = [],
) {
  return {
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
    toolNames,
  };
}

function record(turns: ReturnType<typeof turn>[], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess",
    turns,
    toolResults: [],
    userPrompts: 0,
    compactBoundaries: 0,
    ...extra,
  };
}

describe("sessionMetrics", () => {
  it("rejects sessions below the turn threshold", () => {
    expect(sessionMetrics(record([turn(1, 1, 1, 1)]), "proj-a", 0)).toBeNull();
  });

  it("computes the cache hit rate as reads over reads plus creations", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(0, 0, 900, 100));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    expect(m.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it("returns a zero hit rate when nothing was cached at all", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(10, 10, 0, 0));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    expect(m.cacheHitRate).toBe(0);
  });

  it("computes per-turn averages", () => {
    const turns = Array.from({ length: 10 }, () => turn(0, 20, 1000, 50));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    expect(m.turns).toBe(10);
    expect(m.cacheReadPerTurn).toBe(1000);
    expect(m.cacheCreationPerTurn).toBe(50);
    expect(m.outputPerTurn).toBe(20);
  });

  it("splits cost into shares that sum to one", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(100, 100, 100, 100));
    const m = sessionMetrics(record(turns), "proj-a", 0)!;
    const total =
      m.cacheReadShare + m.outputShare + m.freshInputShare + m.cacheWriteShare;
    expect(total).toBeCloseTo(1, 10);
  });

  it("carries the anonymised label, subagent count and prompt count through", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(1, 1, 1, 1));
    const m = sessionMetrics(record(turns, { userPrompts: 4 }), "proj-c", 7)!;
    expect(m.projectLabel).toBe("proj-c");
    expect(m.subagentCount).toBe(7);
    expect(m.userPrompts).toBe(4);
  });
});

describe("pearson", () => {
  it("is 1 for a perfectly increasing relationship", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("is -1 for a perfectly decreasing relationship", () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it("is 0 when one series has no variance", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it("is 0 for fewer than two points", () => {
    expect(pearson([1], [1])).toBe(0);
  });
});

describe("toolProfiles", () => {
  it("aggregates result sizes per tool, largest total first", () => {
    const r = record([], {
      toolResults: [
        { toolName: "Bash", bytes: 100 },
        { toolName: "Bash", bytes: 300 },
        { toolName: "Read", bytes: 50 },
      ],
    });

    const profiles = toolProfiles([r]);
    expect(profiles[0]!.tool).toBe("Bash");
    expect(profiles[0]!.calls).toBe(2);
    expect(profiles[0]!.totalBytes).toBe(400);
    expect(profiles[0]!.bytes.p50).toBe(200);
    expect(profiles[1]!.tool).toBe("Read");
  });

  it("buckets unattributable results under a named placeholder", () => {
    const r = record([], { toolResults: [{ toolName: null, bytes: 10 }] });
    expect(toolProfiles([r])[0]!.tool).toBe("(unattributed)");
  });

  it("merges different operations on the same MCP server into one bucket", () => {
    const r = record([], {
      toolResults: [
        { toolName: "mcp__foundry__servicenow_query", bytes: 100 },
        { toolName: "mcp__foundry__servicenow_code", bytes: 300 },
      ],
    });

    const profiles = toolProfiles([r]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.tool).toBe("mcp:foundry");
    expect(profiles[0]!.calls).toBe(2);
    expect(profiles[0]!.totalBytes).toBe(400);
  });
});

describe("compareDelegation", () => {
  it("splits sessions by whether they used subagents", () => {
    const turns = Array.from({ length: MIN_TURNS }, () => turn(0, 0, 1000, 0));
    const withSub = sessionMetrics(record(turns), "proj-a", 3)!;
    const withoutSub = sessionMetrics(record(turns), "proj-b", 0)!;

    const cmp = compareDelegation([withSub, withoutSub]);
    expect(cmp.sessionsWith).toBe(1);
    expect(cmp.sessionsWithout).toBe(1);
    expect(cmp.cacheReadPerTurnWith.n).toBe(1);
  });
});

describe("scoreSignals", () => {
  /** A spread of sessions of differing scale, so percentiles actually differ. */
  function spread(): ReturnType<typeof sessionMetrics>[] {
    return [1, 2, 3, 4, 5].map((k) =>
      sessionMetrics(
        record(Array.from({ length: MIN_TURNS }, () => turn(0, 10 * k, 1000 * k, 100))),
        "proj-a",
        0,
      ),
    );
  }

  it("scores every candidate signal with a finite dynamic range", () => {
    const scores = scoreSignals(spread().filter((m) => m !== null));
    const names = scores.map((s) => s.signal);
    expect(names).toContain("cache-hit-rate");
    expect(names).toContain("cache-read-per-turn");
    expect(scores.every((s) => Number.isFinite(s.dynamicRange))).toBe(true);
  });

  it("marks which signals the live stdin payload can support", () => {
    const scores = scoreSignals(spread().filter((m) => m !== null));
    expect(scores.find((s) => s.signal === "cache-hit-rate")!.availability).toBe("stdin");
    expect(scores.find((s) => s.signal === "cache-read-per-turn")!.availability).toBe(
      "transcript",
    );
  });
});

describe("normaliseToolName", () => {
  it("collapses an MCP tool to its server", () => {
    expect(normaliseToolName("mcp__foundry__servicenow_query")).toBe("mcp:foundry");
    expect(normaliseToolName("mcp__claude-in-chrome__computer")).toBe("mcp:claude-in-chrome");
  });

  it("leaves built-in tool names alone", () => {
    expect(normaliseToolName("Bash")).toBe("Bash");
    expect(normaliseToolName("Edit")).toBe("Edit");
  });

  it("maps a null tool name to the unattributed bucket", () => {
    expect(normaliseToolName(null)).toBe("(unattributed)");
  });

  it("handles an MCP name with no operation separator", () => {
    expect(normaliseToolName("mcp__server")).toBe("mcp:server");
  });
});
