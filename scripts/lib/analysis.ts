import type { SessionRecord } from "./parse.ts";
import { type Summary, summarize, costEquivalent, COST_WEIGHTS } from "./stats.ts";

/** Sessions below this many assistant turns are too short to characterise. */
export const MIN_TURNS = 5;

export interface SessionMetrics {
  projectLabel: string;
  turns: number;
  /** Genuine user prompts — not tool results, not injected context. */
  userPrompts: number;
  cacheHitRate: number;
  cacheReadPerTurn: number;
  cacheCreationPerTurn: number;
  outputPerTurn: number;
  /** Total session cost in input-token-equivalents. */
  totalCostEquivalent: number;
  cacheReadShare: number;
  outputShare: number;
  freshInputShare: number;
  cacheWriteShare: number;
  toolResultBytes: number;
  subagentCount: number;
  compactBoundaries: number;
}

export function sessionMetrics(
  record: SessionRecord,
  projectLabel: string,
  subagentCount: number,
): SessionMetrics | null {
  const turns = record.turns;
  if (turns.length < MIN_TURNS) return null;

  let input = 0;
  let output = 0;
  let reads = 0;
  let creations = 0;
  for (const t of turns) {
    input += t.usage.inputTokens;
    output += t.usage.outputTokens;
    reads += t.usage.cacheReadTokens;
    creations += t.usage.cacheCreationTokens;
  }

  const cached = reads + creations;
  const total = costEquivalent({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: reads,
    cacheCreationTokens: creations,
  });
  const share = (weighted: number) => (total === 0 ? 0 : weighted / total);

  return {
    projectLabel,
    turns: turns.length,
    userPrompts: record.userPrompts,
    cacheHitRate: cached === 0 ? 0 : reads / cached,
    cacheReadPerTurn: reads / turns.length,
    cacheCreationPerTurn: creations / turns.length,
    outputPerTurn: output / turns.length,
    totalCostEquivalent: total,
    cacheReadShare: share(reads * COST_WEIGHTS.cacheRead),
    outputShare: share(output * COST_WEIGHTS.output),
    freshInputShare: share(input * COST_WEIGHTS.input),
    cacheWriteShare: share(creations * COST_WEIGHTS.cacheWrite),
    toolResultBytes: record.toolResults.reduce((n, r) => n + r.bytes, 0),
    subagentCount,
    compactBoundaries: record.compactBoundaries,
  };
}

/** Pearson correlation. Returns 0 when either series has no variance. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  const meanX = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

export interface ToolProfile {
  tool: string;
  calls: number;
  totalBytes: number;
  bytes: Summary;
}

const UNATTRIBUTED = "(unattributed)";
const MCP_PREFIX = "mcp__";

/**
 * Bucket key for a tool result. MCP tools are reported at server
 * granularity — `mcp__foundry__servicenow_query` becomes `mcp:foundry` —
 * because the per-operation names identify specific client engagements and
 * this analysis is published in a public repository. Which server returns
 * huge results is the finding; which of its operations did is not.
 */
export function normaliseToolName(toolName: string | null): string {
  if (toolName === null) return UNATTRIBUTED;
  if (!toolName.startsWith(MCP_PREFIX)) return toolName;
  const rest = toolName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf("__");
  return `mcp:${separator === -1 ? rest : rest.slice(0, separator)}`;
}

/** Result-size distribution per tool, ordered by total bytes descending. */
export function toolProfiles(records: SessionRecord[]): ToolProfile[] {
  const byTool = new Map<string, number[]>();
  for (const record of records) {
    for (const result of record.toolResults) {
      const key = normaliseToolName(result.toolName);
      const bucket = byTool.get(key);
      if (bucket) bucket.push(result.bytes);
      else byTool.set(key, [result.bytes]);
    }
  }

  return [...byTool.entries()]
    .map(([tool, sizes]) => ({
      tool,
      calls: sizes.length,
      totalBytes: sizes.reduce((a, b) => a + b, 0),
      bytes: summarize(sizes),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

export interface DelegationComparison {
  sessionsWith: number;
  sessionsWithout: number;
  cacheReadPerTurnWith: Summary;
  cacheReadPerTurnWithout: Summary;
}

/**
 * Does delegating to subagents slow the main context's growth? Compares
 * cache_read per turn — the dominant cost term — between sessions that
 * spawned subagents and sessions that did not.
 */
export function compareDelegation(metrics: SessionMetrics[]): DelegationComparison {
  const withSub = metrics.filter((m) => m.subagentCount > 0);
  const withoutSub = metrics.filter((m) => m.subagentCount === 0);
  return {
    sessionsWith: withSub.length,
    sessionsWithout: withoutSub.length,
    cacheReadPerTurnWith: summarize(withSub.map((m) => m.cacheReadPerTurn)),
    cacheReadPerTurnWithout: summarize(withoutSub.map((m) => m.cacheReadPerTurn)),
  };
}

export interface SignalScore {
  signal: string;
  /** Whether a live statusline payload can compute this, or only a transcript read can. */
  availability: "stdin" | "transcript";
  summary: Summary;
  /** p90 - p10: how far the signal actually moves across real sessions. */
  dynamicRange: number;
  /** Pearson correlation against total session cost. */
  costCorrelation: number;
}

const CANDIDATES: Array<{
  signal: string;
  availability: "stdin" | "transcript";
  pick: (m: SessionMetrics) => number;
}> = [
  { signal: "cache-hit-rate", availability: "stdin", pick: (m) => m.cacheHitRate },
  { signal: "cache-read-per-turn", availability: "transcript", pick: (m) => m.cacheReadPerTurn },
  { signal: "cache-creation-per-turn", availability: "transcript", pick: (m) => m.cacheCreationPerTurn },
  { signal: "output-per-turn", availability: "transcript", pick: (m) => m.outputPerTurn },
  { signal: "cache-read-share-of-cost", availability: "stdin", pick: (m) => m.cacheReadShare },
  { signal: "output-share-of-cost", availability: "stdin", pick: (m) => m.outputShare },
];

export function scoreSignals(metrics: SessionMetrics[]): SignalScore[] {
  const costs = metrics.map((m) => m.totalCostEquivalent);
  return CANDIDATES.map(({ signal, availability, pick }) => {
    const values = metrics.map(pick);
    const summary = summarize(values);
    return {
      signal,
      availability,
      summary,
      dynamicRange: summary.p90 - summary.p10,
      costCorrelation: pearson(values, costs),
    };
  });
}
