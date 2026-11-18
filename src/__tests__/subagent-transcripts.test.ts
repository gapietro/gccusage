import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findSessionJsonlFiles,
  findSessionTranscripts,
  findTodayJsonlFileStats,
} from "../utils/paths.js";
import { buildRenderContext } from "../data/pipeline.js";
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import { localDateKey } from "../utils/local-date.js";

/**
 * COR-007: subagent transcripts were never read.
 *
 * Claude Code writes a subagent's usage to its own transcript under the parent
 * session's directory, not to the parent `<sessionId>.jsonl`:
 *
 *   <project>/<sessionId>.jsonl                                   main
 *   <project>/<sessionId>/subagents/agent-<id>.jsonl              Task agents
 *   <project>/<sessionId>/subagents/workflows/<run>/agent-<id>.jsonl
 *                                                                 workflow agents
 *
 * beside non-transcript siblings (`agent-<id>.meta.json`, a workflow run's
 * `journal.jsonl`, `tool-results/`). The layout here is synthetic, built to
 * match the real directory structure; no real transcript content is used.
 * Measured on the developer's machine, the agent files' message ids overlap
 * the parent's in 1 of 1,688 (and 0 of 4,516 for workflow agents), so their
 * usage is missing from every calculated figure, not double-counted.
 */

// Pinned so calculated costs are exact: $1 per 1M input tokens.
const PINNED_PRICING = {
  "test-model": {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheCreation1hCostPerToken: 0,
    cacheReadCostPerToken: 0,
  },
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  // stale: false, or the pipeline would spawn a real detached refresher.
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));

// Pass-through spy, so cache reuse can be observed as "not re-parsed".
vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});

const SESSION = "0c070007-aaaa-4bbb-8ccc-000000000007";
const OTHER_SESSION = "0c070007-dddd-4eee-8fff-000000000008";

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cor007-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpDir;
  process.env["XDG_CACHE_HOME"] = path.join(tmpDir, "cache");
  vi.mocked(parseJsonlFile).mockClear();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function projectDir(name = "-proj"): string {
  const dir = path.join(tmpDir, ".claude", "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One priced response: `inputTokens` at $1/1M. */
function transcriptLine(messageId: string, inputTokens: number, when = new Date()): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: when.toISOString(),
    sessionId: SESSION,
    message: {
      id: messageId,
      model: "test-model",
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

function writeFile(filePath: string, lines: string[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function age(filePath: string, when: Date): void {
  fs.utimesSync(filePath, when, when);
}

const YESTERDAY = new Date(Date.now() - 26 * 60 * 60 * 1000);

interface SessionLayout {
  main: string;
  agents: string[];
  workflowAgent: string;
  /** Files that sit in the subagents tree but are not transcripts. */
  decoys: string[];
}

/**
 * A main transcript worth $0.10, three Task-agent transcripts worth $0.20,
 * $0.30 and $0.40, one workflow-agent transcript worth $0.50, and the
 * non-transcript siblings Claude Code writes beside them, which must be
 * ignored.
 */
function writeSessionWithSubagents(sessionId = SESSION, project = "-proj"): SessionLayout {
  const dir = projectDir(project);
  const sessionDir = path.join(dir, sessionId);
  const subagents = path.join(sessionDir, "subagents");
  const main = writeFile(path.join(dir, `${sessionId}.jsonl`), [transcriptLine("msg_main", 100_000)]);
  const agents = [
    writeFile(path.join(subagents, "agent-a1.jsonl"), [transcriptLine("msg_a1", 200_000)]),
    writeFile(path.join(subagents, "agent-a2.jsonl"), [transcriptLine("msg_a2", 300_000)]),
    writeFile(path.join(subagents, "agent-a3.jsonl"), [transcriptLine("msg_a3", 400_000)]),
  ];
  const workflowAgent = writeFile(path.join(subagents, "workflows", "wf_run1", "agent-w1.jsonl"), [
    transcriptLine("msg_w1", 500_000),
  ]);
  // Priced lines in every decoy, so reading one would show up in the totals.
  const decoys = [
    writeFile(path.join(subagents, "agent-a1.meta.json"), [transcriptLine("msg_d1", 9_000_000)]),
    writeFile(path.join(subagents, "workflows", "wf_run1", "journal.jsonl"), [
      transcriptLine("msg_d2", 9_000_000),
    ]),
    writeFile(path.join(sessionDir, "tool-results", "agent-t1.jsonl"), [
      transcriptLine("msg_d3", 9_000_000),
    ]),
    writeFile(path.join(subagents, "nested", "deeper", "agent-n1.jsonl"), [
      transcriptLine("msg_d4", 9_000_000),
    ]),
  ];
  return { main, agents, workflowAgent, decoys };
}

function settingsWith(costSource: Settings["costSource"]): Settings {
  return { ...DEFAULT_SETTINGS, costSource };
}

describe("findSessionJsonlFiles reads subagent transcripts (COR-007)", () => {
  it("returns the main transcript and every Task and workflow agent transcript", () => {
    const layout = writeSessionWithSubagents();

    expect([...findSessionJsonlFiles(SESSION)].sort()).toEqual(
      [layout.main, ...layout.agents, layout.workflowAgent].sort(),
    );
    // Split by kind: the start time and turn count come from `main`, so no caller
    // depends on list order (PR #156 review).
    const split = findSessionTranscripts(SESSION);
    expect(split.main).toEqual([layout.main]);
    expect([...split.subagents].sort()).toEqual([...layout.agents, layout.workflowAgent].sort());
  });

  it("ignores meta files, journals, tool results and deeper nesting", () => {
    const layout = writeSessionWithSubagents();
    const files = findSessionJsonlFiles(SESSION);
    for (const decoy of layout.decoys) expect(files).not.toContain(decoy);
  });

  it("does not pick up another session's subagents", () => {
    writeSessionWithSubagents();
    const other = writeSessionWithSubagents(OTHER_SESSION);
    const files = findSessionJsonlFiles(SESSION);
    for (const f of [other.main, ...other.agents, other.workflowAgent]) {
      expect(files).not.toContain(f);
    }
  });

  it("returns just the main transcript when the session has no subagents dir", () => {
    const main = writeFile(path.join(projectDir(), `${SESSION}.jsonl`), [
      transcriptLine("msg_main", 100_000),
    ]);
    expect(findSessionJsonlFiles(SESSION)).toEqual([main]);
  });

  it("still returns the main transcript when `subagents` is unreadable", () => {
    const dir = projectDir();
    const main = writeFile(path.join(dir, `${SESSION}.jsonl`), [transcriptLine("msg_main", 100_000)]);
    // A regular file where the directory should be: readdir throws ENOTDIR.
    // Unlike chmod 000 this also fails when the suite runs as root.
    writeFile(path.join(dir, SESSION, "subagents"), ["not a directory"]);

    expect(findSessionJsonlFiles(SESSION)).toEqual([main]);
  });

  it("never joins an unsafe session id into a path", () => {
    // stdin's session_id used to be compared only against basenames. Joining
    // "../escape" under a project dir would resolve to projects/escape.
    const escapeAgent = writeFile(
      path.join(tmpDir, ".claude", "projects", "escape", "subagents", "agent-x.jsonl"),
      [transcriptLine("msg_x", 1_000_000)],
    );
    projectDir();

    expect(findSessionJsonlFiles("../escape")).not.toContain(escapeAgent);
    expect(findSessionJsonlFiles("../escape")).toEqual([]);
  });
});

describe("findTodayJsonlFileStats walks subagent dirs (COR-007)", () => {
  it("includes today's Task and workflow agent transcripts, with their stats", () => {
    const layout = writeSessionWithSubagents();

    const stats = findTodayJsonlFileStats();
    const paths = stats.map((s) => s.path).sort();

    expect(paths).toEqual([layout.main, ...layout.agents, layout.workflowAgent].sort());
    const agent = stats.find((s) => s.path === layout.agents[0])!;
    const real = fs.statSync(layout.agents[0]!);
    expect(agent.size).toBe(real.size);
    expect(agent.mtimeMs).toBe(real.mtimeMs);
  });

  it("excludes subagent transcripts last written before today", () => {
    const layout = writeSessionWithSubagents();
    for (const f of [layout.main, ...layout.agents, layout.workflowAgent]) age(f, YESTERDAY);

    expect(findTodayJsonlFileStats()).toEqual([]);
  });

  it("keeps a subagent written today even when its parent transcript was not", () => {
    // A session left open over midnight: the parent's last line was
    // yesterday, its subagent is still working today.
    const layout = writeSessionWithSubagents();
    age(layout.main, YESTERDAY);

    expect(findTodayJsonlFileStats().map((s) => s.path)).toContain(layout.agents[0]);
  });

  it("still reports other transcripts when one session's `subagents` is unreadable", () => {
    const dir = projectDir();
    const main = writeFile(path.join(dir, `${SESSION}.jsonl`), [transcriptLine("msg_main", 1)]);
    writeFile(path.join(dir, SESSION, "subagents"), ["not a directory"]);
    const other = writeSessionWithSubagents(OTHER_SESSION);

    const paths = findTodayJsonlFileStats().map((s) => s.path);

    expect(paths).toContain(main);
    expect(paths).toContain(other.main);
    expect(paths).toContain(other.agents[0]);
  });
});

describe("calculated costs include subagent usage (COR-007)", () => {
  it("prices the main transcript and all three Task agents, plus the workflow agent", async () => {
    writeSessionWithSubagents();

    const ctx = await buildRenderContext(
      { session_id: SESSION, model: "test-model" },
      settingsWith("calculated"),
    );

    // $0.10 main + $0.20 + $0.30 + $0.40 agents + $0.50 workflow agent.
    // Pre-fix this was $0.10: the main transcript alone.
    expect(ctx.sessionCostUsd).toBeCloseTo(1.5, 10);
    expect(ctx.metrics.totals.inputTokens).toBe(1_500_000);
    expect(ctx.costByModel.get("test-model")).toBeCloseTo(1.5, 10);
  });

  it("prices a session whose subagents dir is unreadable from its main transcript", async () => {
    const dir = projectDir();
    writeFile(path.join(dir, `${SESSION}.jsonl`), [transcriptLine("msg_main", 100_000)]);
    writeFile(path.join(dir, SESSION, "subagents"), ["not a directory"]);

    const ctx = await buildRenderContext(
      { session_id: SESSION, model: "test-model" },
      settingsWith("calculated"),
    );

    expect(ctx.sessionCostUsd).toBeCloseTo(0.1, 10);
  });

  it("includes subagent transcripts in Today: under costSource calculated", async () => {
    writeSessionWithSubagents();
    writeSessionWithSubagents(OTHER_SESSION, "-other-proj");

    const ctx = await buildRenderContext(
      { session_id: SESSION, model: "test-model" },
      settingsWith("calculated"),
    );

    // Two sessions at $1.50 each. Pre-fix: $0.20, the two main transcripts.
    expect(ctx.todayCostUsd).toBeCloseTo(3.0, 10);
  });
});

describe("the today-aggregate cache with subagent transcripts (COR-007)", () => {
  it("caches subagent files by path and reuses them while unchanged", () => {
    const layout = writeSessionWithSubagents();

    expect(getTodayAggregate().totals.inputTokens).toBe(1_500_000);
    vi.mocked(parseJsonlFile).mockClear();

    expect(getTodayAggregate().totals.inputTokens).toBe(1_500_000);
    expect(vi.mocked(parseJsonlFile)).not.toHaveBeenCalled();

    // A subagent that grows is re-parsed on its own; the rest stay cached.
    fs.appendFileSync(layout.agents[1]!, transcriptLine("msg_a2b", 1_000_000) + "\n");
    const future = new Date(Date.now() + 1000);
    age(layout.agents[1]!, future);

    expect(getTodayAggregate().totals.inputTokens).toBe(2_500_000);
    expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([layout.agents[1]]);
  });

  it("picks up subagent files missing from a cache written before they were read", () => {
    // A cache written by a build that walked only top-level transcripts holds
    // just the main file. Its subagent files are new keys: no schema bump is
    // needed for them to be parsed and added.
    const layout = writeSessionWithSubagents();
    const stat = fs.statSync(layout.main);
    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const now = new Date();
    const date = localDateKey(now);
    const zero = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    };
    const mainMetrics = { ...zero, inputTokens: 100_000, premium: zero };
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        date,
        files: {
          [layout.main]: {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            byModel: [["test-model", mainMetrics]],
            totals: mainMetrics,
            firstTimestamp: null,
            humanTurns: 0,
          },
        },
      }),
    );

    expect(getTodayAggregate().totals.inputTokens).toBe(1_500_000);
    const parsed = vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0]);
    expect(parsed).not.toContain(layout.main);
    expect(parsed.sort()).toEqual([...layout.agents, layout.workflowAgent].sort());
  });
});
