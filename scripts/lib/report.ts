import { discoverSessions } from "./discover.ts";
import { readTranscript, type SessionRecord } from "./parse.ts";
import { summarize, type Summary } from "./stats.ts";
import {
  MIN_TURNS,
  sessionMetrics,
  toolProfiles,
  compareDelegation,
  scoreSignals,
  type SessionMetrics,
  type ToolProfile,
  type DelegationComparison,
  type SignalScore,
} from "./analysis.ts";

export interface Report {
  corpus: {
    projects: number;
    mainSessions: number;
    subagentTranscripts: number;
    analysedSessions: number;
    minTurns: number;
    assistantTurns: number;
    compactBoundaries: number;
  };
  decomposition: {
    cacheReadShare: Summary;
    outputShare: Summary;
    freshInputShare: Summary;
    cacheWriteShare: Summary;
    cacheReadPerTurn: Summary;
    cacheCreationPerTurn: Summary;
    outputPerTurn: Summary;
    turnsPerSession: Summary;
    userPromptsPerSession: Summary;
    /** Assistant turns per user prompt — how much work one ask costs. */
    turnsPerPrompt: Summary;
  };
  tools: ToolProfile[];
  delegation: DelegationComparison;
  signals: SignalScore[];
  sessions: SessionMetrics[];
}

export function buildReport(projectsDir: string): Report {
  const paths = discoverSessions(projectsDir);
  const records: SessionRecord[] = [];
  const metrics: SessionMetrics[] = [];
  let subagentTranscripts = 0;

  for (const p of paths) {
    const record = readTranscript(p.mainPath, p.sessionId);
    records.push(record);
    subagentTranscripts += p.subagentPaths.length;

    const m = sessionMetrics(record, p.projectLabel, p.subagentPaths.length);
    if (m) metrics.push(m);
  }

  return {
    corpus: {
      projects: new Set(paths.map((p) => p.projectLabel)).size,
      mainSessions: paths.length,
      subagentTranscripts,
      analysedSessions: metrics.length,
      minTurns: MIN_TURNS,
      assistantTurns: metrics.reduce((n, m) => n + m.turns, 0),
      compactBoundaries: records.reduce((n, r) => n + r.compactBoundaries, 0),
    },
    decomposition: {
      cacheReadShare: summarize(metrics.map((m) => m.cacheReadShare)),
      outputShare: summarize(metrics.map((m) => m.outputShare)),
      freshInputShare: summarize(metrics.map((m) => m.freshInputShare)),
      cacheWriteShare: summarize(metrics.map((m) => m.cacheWriteShare)),
      cacheReadPerTurn: summarize(metrics.map((m) => m.cacheReadPerTurn)),
      cacheCreationPerTurn: summarize(metrics.map((m) => m.cacheCreationPerTurn)),
      outputPerTurn: summarize(metrics.map((m) => m.outputPerTurn)),
      turnsPerSession: summarize(metrics.map((m) => m.turns)),
      userPromptsPerSession: summarize(metrics.map((m) => m.userPrompts)),
      turnsPerPrompt: summarize(
        metrics.filter((m) => m.userPrompts > 0).map((m) => m.turns / m.userPrompts),
      ),
    },
    tools: toolProfiles(records),
    delegation: compareDelegation(metrics),
    signals: scoreSignals(metrics),
    sessions: metrics,
  };
}

function n0(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "n/a";
}

function n1(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "n/a";
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function summaryRow(label: string, s: Summary, format: (v: number) => string): string {
  return `| ${label} | ${format(s.p10)} | ${format(s.p50)} | ${format(s.p90)} | ${format(s.max)} |`;
}

export function renderMarkdown(report: Report): string {
  const { corpus, decomposition, tools, delegation, signals } = report;
  const out: string[] = [];

  out.push("## Corpus", "");
  out.push(`- Projects: ${corpus.projects}`);
  out.push(`- Main session transcripts: ${corpus.mainSessions}`);
  out.push(`- Subagent transcripts: ${corpus.subagentTranscripts}`);
  out.push(`- Sessions analysed (>= ${corpus.minTurns} assistant turns): ${corpus.analysedSessions}`);
  out.push(`- Assistant turns analysed: ${n0(corpus.assistantTurns)}`);
  out.push(`- Compaction boundaries observed: ${corpus.compactBoundaries}`);
  out.push("");

  out.push("## Cost decomposition", "");
  out.push("Share of session cost in input-token-equivalents (output 5x, cache write 1.25x, cache read 0.1x).", "");
  out.push("| Component | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("Cache reads", decomposition.cacheReadShare, pct));
  out.push(summaryRow("Output", decomposition.outputShare, pct));
  out.push(summaryRow("Fresh input", decomposition.freshInputShare, pct));
  out.push(summaryRow("Cache writes", decomposition.cacheWriteShare, pct));
  out.push("");
  out.push("| Per-turn tokens | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("Cache read", decomposition.cacheReadPerTurn, n0));
  out.push(summaryRow("Cache creation", decomposition.cacheCreationPerTurn, n0));
  out.push(summaryRow("Output", decomposition.outputPerTurn, n0));
  out.push("");
  out.push("| Session shape | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("Assistant turns", decomposition.turnsPerSession, n0));
  out.push(summaryRow("User prompts", decomposition.userPromptsPerSession, n0));
  out.push(summaryRow("Turns per prompt", decomposition.turnsPerPrompt, n1));
  out.push("");

  out.push("## Tool result sizes", "");
  out.push("| Tool | Calls | Total bytes | p50 | p90 | p99 | max |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tools.slice(0, 15)) {
    out.push(
      `| ${t.tool} | ${n0(t.calls)} | ${n0(t.totalBytes)} | ${n0(t.bytes.p50)} | ${n0(t.bytes.p90)} | ${n0(t.bytes.p99)} | ${n0(t.bytes.max)} |`,
    );
  }
  if (tools.length > 15) out.push("", `_${tools.length - 15} further tools omitted from this table._`);
  out.push("");

  out.push("## Subagent delegation", "");
  out.push(`- Sessions that spawned subagents: ${delegation.sessionsWith}`);
  out.push(`- Sessions that did not: ${delegation.sessionsWithout}`);
  out.push("");
  out.push("| Cache read per turn | p10 | p50 | p90 | max |");
  out.push("| --- | --- | --- | --- | --- |");
  out.push(summaryRow("With subagents", delegation.cacheReadPerTurnWith, n0));
  out.push(summaryRow("Without subagents", delegation.cacheReadPerTurnWithout, n0));
  out.push("");

  out.push("## Candidate signals", "");
  out.push("| Signal | Available from | p10 | p50 | p90 | Dynamic range (p90-p10) | Cost correlation |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of signals) {
    const isShare = s.signal.includes("share") || s.signal === "cache-hit-rate";
    const f = isShare ? pct : n0;
    out.push(
      `| ${s.signal} | ${s.availability} | ${f(s.summary.p10)} | ${f(s.summary.p50)} | ${f(s.summary.p90)} | ${f(s.dynamicRange)} | ${s.costCorrelation.toFixed(2)} |`,
    );
  }
  out.push("");

  return out.join("\n");
}
