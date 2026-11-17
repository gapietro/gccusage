import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { RenderContext } from "../types/render-context.js";

/**
 * COR-007 follow-up (PR #156 review): reading subagent transcripts made every
 * uncached render re-parse every one of them. On the developer's largest
 * session (177 agent files, 213 MB, plus a 54 MB main transcript) that took
 * the transcript read from 120–140 ms to 640–750 ms. A finished agent
 * transcript never changes, so each session file's aggregate is now cached on
 * (path, mtimeMs, size), as today's already were, and only live files are
 * re-parsed.
 *
 * Calls go through `buildRenderContext` under `costSource: "auto"` with no
 * stdin cost: the session is priced from its transcripts, while Today comes
 * from the daily store, so every parse observed here is a session read.
 */

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

// Pass-through spy: real parsing, every path read recorded.
vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});

const SESSION = "5e550000-aaaa-4bbb-8ccc-000000000156";
const OTHER = "5e550000-dddd-4eee-8fff-000000000157";
const HOUR_MS = 3_600_000;

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-session-agg-"));
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

function assistant(id: string, inputTokens: number, when: Date): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: when.toISOString(),
    message: { id, model: "test-model", usage: { input_tokens: inputTokens, output_tokens: 0 } },
  });
}

function user(kind: string, when: Date): string {
  return JSON.stringify({ type: "user", timestamp: when.toISOString(), origin: { kind } });
}

function writeFile(filePath: string, lines: string[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

/** Append and move the mtime forward, so the change is seen on any clock. */
function append(filePath: string, lines: string[]): void {
  fs.appendFileSync(filePath, lines.join("\n") + "\n");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(filePath, future, future);
}

interface Layout {
  main: string;
  agents: string[];
}

const START = new Date(Date.now() - HOUR_MS);
const LATER = new Date(START.getTime() + 60_000);

/**
 * Main: two typed prompts and $0.10. Three agents at $0.20 each, one of them
 * a workflow agent. Agent lines start a minute after the main transcript.
 */
function writeSession(sessionId = SESSION, project = "-proj"): Layout {
  const dir = path.join(tmpDir, ".claude", "projects", project);
  const sub = path.join(dir, sessionId, "subagents");
  const main = writeFile(path.join(dir, `${sessionId}.jsonl`), [
    user("human", START),
    assistant("m1", 100_000, START),
    user("human", LATER),
  ]);
  const agents = [
    writeFile(path.join(sub, "agent-a1.jsonl"), [assistant("a1", 200_000, LATER)]),
    writeFile(path.join(sub, "agent-a2.jsonl"), [assistant("a2", 200_000, LATER)]),
    writeFile(path.join(sub, "workflows", "wf_1", "agent-w1.jsonl"), [
      assistant("w1", 200_000, LATER),
    ]),
  ];
  return { main, agents };
}

async function build(sessionId = SESSION): Promise<RenderContext> {
  return buildRenderContext(
    { session_id: sessionId, model: "test-model" },
    { ...DEFAULT_SETTINGS, costSource: "auto" },
  );
}

function parsedPaths(): string[] {
  return vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0]);
}

function cacheDir(): string {
  return path.join(tmpDir, "cache", "gccusage", "session-aggregates");
}

describe("the session aggregate cache (COR-007)", () => {
  it("does not re-parse unchanged session files on a second build", async () => {
    const layout = writeSession();

    const first = await build();
    expect(parsedPaths().sort()).toEqual([layout.main, ...layout.agents].sort());
    vi.mocked(parseJsonlFile).mockClear();

    const second = await build();

    // Pre-fix: all four files re-parsed on every build.
    expect(parsedPaths()).toEqual([]);
    expect(second.sessionCostUsd).toBeCloseTo(0.7, 10);
    expect(second.metrics.totals.inputTokens).toBe(700_000);
    expect(second.costByModel.get("test-model")).toBeCloseTo(0.7, 10);
    expect(second.sessionStartTime).toBe(first.sessionStartTime);
    expect(second.sessionStartTime).toBe(START.getTime());
    expect(second.turnCount).toBe(2);
  });

  it("re-parses only an agent file that changed", async () => {
    const layout = writeSession();
    await build();
    vi.mocked(parseJsonlFile).mockClear();

    append(layout.agents[1]!, [assistant("a2b", 1_000_000, LATER)]);
    const ctx = await build();

    expect(parsedPaths()).toEqual([layout.agents[1]]);
    expect(ctx.sessionCostUsd).toBeCloseTo(1.7, 10);
  });

  it("re-parses only the live main transcript as it grows", async () => {
    const layout = writeSession();
    await build();
    vi.mocked(parseJsonlFile).mockClear();

    append(layout.main, [user("human", new Date()), assistant("m2", 1_000_000, new Date())]);
    const ctx = await build();

    expect(parsedPaths()).toEqual([layout.main]);
    expect(ctx.sessionCostUsd).toBeCloseTo(1.7, 10);
    expect(ctx.turnCount).toBe(3);
  });

  it("drops a file that disappeared from the session", async () => {
    const layout = writeSession();
    await build();

    fs.rmSync(layout.agents[0]!);
    const ctx = await build();

    expect(ctx.sessionCostUsd).toBeCloseTo(0.5, 10);
  });

  it("keeps two sessions' caches apart, so they do not evict each other", async () => {
    writeSession(SESSION);
    writeSession(OTHER);
    await build(SESSION);
    await build(OTHER);
    vi.mocked(parseJsonlFile).mockClear();

    await build(SESSION);
    await build(OTHER);

    expect(parsedPaths()).toEqual([]);
  });

  it("still prices the session when the cache cannot be written", async () => {
    writeSession();
    // A regular file where the cache's directory should be.
    fs.mkdirSync(path.dirname(cacheDir()), { recursive: true });
    fs.writeFileSync(cacheDir(), "not a directory");

    expect((await build()).sessionCostUsd).toBeCloseTo(0.7, 10);
    expect((await build()).sessionCostUsd).toBeCloseTo(0.7, 10);
  });

  it("discards a cached count of 1e400 instead of reading it as Infinity", async () => {
    // `JSON.parse` overflows 1e400 to Infinity, which plain `v.number()`
    // accepts. One infinite count would make the session cost non-finite.
    const layout = writeSession();
    await build();
    const [shard] = fs.readdirSync(cacheDir());
    const shardPath = path.join(cacheDir(), shard!);
    const raw = fs.readFileSync(shardPath, "utf8");
    const poisoned = raw.replace('"inputTokens":100000', '"inputTokens":1e400');
    expect(poisoned).not.toBe(raw);
    fs.writeFileSync(shardPath, poisoned);
    vi.mocked(parseJsonlFile).mockClear();

    const ctx = await build();

    expect(parsedPaths()).toContain(layout.main);
    expect(ctx.sessionCostUsd).toBeCloseTo(0.7, 10);
  });

  it("removes another session's cache untouched for over a week when creating one", async () => {
    // One cache file per session; without a sweep they would pile up forever.
    fs.mkdirSync(cacheDir(), { recursive: true });
    const stale = path.join(cacheDir(), "stale-session.json");
    const recent = path.join(cacheDir(), "recent-session.json");
    fs.writeFileSync(stale, "{}");
    fs.writeFileSync(recent, "{}");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * HOUR_MS);
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

    writeSession();
    await build();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.readdirSync(cacheDir())).toHaveLength(2);
  });

  it("does not touch the cache for a render with no session id", async () => {
    writeSession();
    await buildRenderContext({ model: "test-model" }, { ...DEFAULT_SETTINGS, costSource: "auto" });
    expect(fs.existsSync(cacheDir())).toBe(false);
  });
});

describe("the turn count with subagent transcripts (PR #156 review)", () => {
  it("ignores a subagent's coordinator prompt", async () => {
    // The `type: "user"` lines in real agent transcripts carry
    // `origin.kind` "coordinator" or "task-notification", never "human".
    writeSession();
    const dir = path.join(tmpDir, ".claude", "projects", "-proj");
    writeFile(path.join(dir, SESSION, "subagents", "agent-c.jsonl"), [
      user("coordinator", LATER),
      assistant("c", 1, LATER),
    ]);

    expect((await build()).turnCount).toBe(2);
  });

  it("counts only the main transcript, whatever a subagent's lines say", async () => {
    // A prompt the user typed into this session is only ever in its main
    // transcript; a subagent's are written by the harness. Counting per kind
    // of line would let a future origin value leak in.
    writeSession();
    const dir = path.join(tmpDir, ".claude", "projects", "-proj");
    writeFile(path.join(dir, SESSION, "subagents", "agent-h.jsonl"), [
      user("human", LATER),
      assistant("h", 1, LATER),
    ]);

    expect((await build()).turnCount).toBe(2);
  });
});

describe("unusual session layouts (PR #156 review)", () => {
  it("prices a session whose main transcript is missing from its subagents", async () => {
    const layout = writeSession();
    fs.rmSync(layout.main);

    const ctx = await build();

    expect(ctx.sessionCostUsd).toBeCloseTo(0.6, 10);
    expect(ctx.sessionStartTime).toBe(LATER.getTime());
    expect(ctx.turnCount).toBe(0);
  });

  it("finds main and subagent transcripts under different project dirs", async () => {
    // Not observed: on the developer's machine all 12 subagent dirs sit
    // beside their main transcript. The lookup searches every project dir
    // for each independently, so it would still find both.
    const layout = writeSession(SESSION, "-first");
    const moved = path.join(tmpDir, ".claude", "projects", "-second", SESSION);
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(path.join(path.dirname(layout.main), SESSION), moved);

    const ctx = await build();

    expect(ctx.sessionCostUsd).toBeCloseTo(0.7, 10);
    expect(ctx.sessionStartTime).toBe(START.getTime());
    expect(ctx.turnCount).toBe(2);
  });
});

describe("the session start time (PR #156 review)", () => {
  const EARLIER = new Date(START.getTime() - 30 * 60_000);

  it("is the main transcript's, even when an agent line is older", async () => {
    // Clock skew, or an agent file left behind by an earlier run under the
    // same id: either way the session started where its main transcript did.
    writeSession();
    const dir = path.join(tmpDir, ".claude", "projects", "-proj");
    writeFile(path.join(dir, SESSION, "subagents", "agent-old.jsonl"), [
      assistant("old", 1, EARLIER),
    ]);

    expect((await build()).sessionStartTime).toBe(START.getTime());
  });

  it("is the earliest of several main transcripts, whatever order they are listed in", async () => {
    const newer = path.join(tmpDir, ".claude", "projects", "-a", `${SESSION}.jsonl`);
    const older = path.join(tmpDir, ".claude", "projects", "-z", `${SESSION}.jsonl`);
    writeFile(newer, [assistant("n", 1, START)]);
    writeFile(older, [assistant("o", 1, EARLIER)]);

    expect((await build()).sessionStartTime).toBe(EARLIER.getTime());
  });

  it("falls back to the subagent transcripts when the main one has no timestamp", async () => {
    const dir = path.join(tmpDir, ".claude", "projects", "-proj");
    writeFile(path.join(dir, `${SESSION}.jsonl`), [JSON.stringify({ type: "summary" })]);
    // The earlier agent is named to sort, and so likely list, last.
    writeFile(path.join(dir, SESSION, "subagents", "agent-a.jsonl"), [assistant("a", 1, LATER)]);
    writeFile(path.join(dir, SESSION, "subagents", "agent-z.jsonl"), [assistant("z", 1, START)]);

    expect((await build()).sessionStartTime).toBe(START.getTime());
  });
});
