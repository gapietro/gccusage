import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";

// Pass-through spy: real parsing, but every path read is recorded. "Did this
// render re-parse the file?" is the whole point of the cache and cannot be
// observed from the returned totals.
vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-today-agg-"));
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

function projectDir(): string {
  const dir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function line(model: string | null, input: number, when: Date): string {
  const message: Record<string, unknown> = {
    usage: { input_tokens: input, output_tokens: 0 },
  };
  if (model !== null) message["model"] = model;
  return JSON.stringify({ type: "assistant", timestamp: when.toISOString(), message });
}

function write(name: string, lines: string[]): string {
  const filePath = path.join(projectDir(), `${name}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function append(filePath: string, lines: string[]): void {
  fs.appendFileSync(filePath, lines.join("\n") + "\n");
  // Guarantee a distinct mtime even on a coarse-grained filesystem clock. The
  // cache also keys on size, so this belt-and-braces step only removes a
  // theoretical flake, it is not what the fix relies on.
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(filePath, future, future);
}

function parsedPaths(): string[] {
  return vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0]);
}

const NOW = new Date();
const EARLIER_TODAY = new Date(NOW.getTime() - 60 * 1000);
const YESTERDAY = new Date(NOW.getTime() - 26 * 60 * 60 * 1000);

describe("getTodayAggregate", () => {
  it("sums today's entries across files, by model and in total", () => {
    write("a", [line("opus", 100, EARLIER_TODAY), line("sonnet", 200, EARLIER_TODAY)]);
    write("b", [line("opus", 300, EARLIER_TODAY)]);

    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(600);
    expect(result.byModel.get("opus")?.inputTokens).toBe(400);
    expect(result.byModel.get("sonnet")?.inputTokens).toBe(200);
    expect(result.fileCount).toBe(2);
  });

  it("excludes entries from before midnight in a file touched today", () => {
    write("a", [line("opus", 100, YESTERDAY), line("opus", 50, EARLIER_TODAY)]);

    expect(getTodayAggregate(NOW).totals.inputTokens).toBe(50);
  });

  it("counts model-less usage in totals but not in byModel", () => {
    write("a", [line(null, 70, EARLIER_TODAY)]);

    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(70);
    expect(result.byModel.size).toBe(0);
  });

  it("does not re-parse anything when no file has changed", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    expect(parsedPaths()).toEqual([]);
    expect(result.totals.inputTokens).toBe(300);
  });

  it("re-parses only the file that changed", () => {
    const a = write("a", [line("opus", 100, EARLIER_TODAY)]);
    write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);
    vi.mocked(parseJsonlFile).mockClear();

    append(a, [line("opus", 5, EARLIER_TODAY)]);
    const result = getTodayAggregate(NOW);

    expect(parsedPaths()).toEqual([a]);
    expect(result.totals.inputTokens).toBe(305);
  });

  it("discards the whole cache when the local date changes", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    getTodayAggregate(NOW);
    vi.mocked(parseJsonlFile).mockClear();

    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    getTodayAggregate(tomorrow);

    expect(parsedPaths()).toHaveLength(1);
  });

  it("drops files that leave today's window", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    const b = write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);

    fs.rmSync(b);
    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(100);
    expect(result.fileCount).toBe(1);
  });

  // The returned totals are rebuilt from the live file list every call, so
  // they are correct whether or not the cache is rewritten. What needs
  // guarding is the persisted file: without the length check that sets
  // `changed`, a dropped file leaves a dead entry behind until midnight.
  it("prunes a departed file from the persisted cache, not just the return value", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    const b = write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);

    fs.rmSync(b);
    getTodayAggregate(NOW);

    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");
    const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(persisted.files)).toEqual([path.join(projectDir(), "a.jsonl")]);
  });

  it("recomputes correctly from a corrupt cache file", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    getTodayAggregate(NOW);

    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");
    fs.writeFileSync(cacheFile, "{ not json");
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    expect(parsedPaths()).toHaveLength(1);
    expect(result.totals.inputTokens).toBe(100);
  });

  it("recomputes correctly from a schema-invalid cache file", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ date: "not-today", files: "nope" }));

    expect(getTodayAggregate(NOW).totals.inputTokens).toBe(100);
  });

  it("returns zeroes when there are no transcripts at all", () => {
    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(0);
    expect(result.byModel.size).toBe(0);
    expect(result.fileCount).toBe(0);
  });

  it("discards a pre-upgrade cache entry that has no premium bucket (#103)", () => {
    const filePath = write("a", [line("opus", 100, EARLIER_TODAY)]);
    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");

    // Prime the cache, then rewrite it in the PRE-UPGRADE shape (no `premium`)
    // with a bogus count, keyed on the live file's real mtime and size so it
    // would be a cache HIT if the schema still accepted it.
    getTodayAggregate(NOW);
    const primed = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as { date: string };
    const stat = fs.statSync(filePath);
    const bogus = {
      inputTokens: 999_999,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        // Reuse the primed file's own date key rather than recomputing it: the
        // module keys on the LOCAL date, and a hand-rolled UTC key makes this
        // pass or fail depending on timezone and hour.
        date: primed.date,
        files: {
          [filePath]: {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            byModel: [["opus", bogus]],
            totals: bogus,
          },
        },
      }),
    );
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    // 100, not 999_999: the pre-upgrade shape was rejected and the transcript
    // re-parsed.
    expect(parsedPaths()).toHaveLength(1);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.totals.premium).toBeDefined();
  });

  // #103's cost-calculator SUBTRACTS `premium` from these base counts to get
  // the standard bucket. A negative count already passed the schema before
  // that change ("wrong but bounded"); the subtraction turns it unbounded —
  // a corrupt inputTokens of -1 could yield an arbitrarily wrong, possibly
  // negative, cost. The schema must reject it at the read boundary rather
  // than let it flow through as a cache hit.
  it("discards a cache entry with a negative count", () => {
    const filePath = write("a", [line("opus", 100, EARLIER_TODAY)]);
    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");

    getTodayAggregate(NOW);
    const primed = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as { date: string };
    const stat = fs.statSync(filePath);
    const negative = {
      inputTokens: -1,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      premium: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        date: primed.date,
        files: {
          [filePath]: {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            byModel: [["opus", negative]],
            totals: negative,
          },
        },
      }),
    );
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    // 100, not -1: the entry with the negative count was rejected and the
    // transcript re-parsed, exactly as the pre-upgrade-shape case above.
    expect(parsedPaths()).toHaveLength(1);
    expect(result.totals.inputTokens).toBe(100);
  });
});
