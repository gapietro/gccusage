import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { StatusJson } from "../types/status-json.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";

const PINNED_PRICING = {
  "test-model": {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheReadCostPerToken: 0,
  },
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));

vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-flatness-"));
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

/**
 * Writes `sess-0` (the rendering session's own transcript) at a FIXED
 * `sessionLines`, and every other file at `linesPerFile`. Holding the session
 * file constant while scaling the rest is what makes the flatness assertion
 * sharp: the warm render must read exactly the session file and nothing else,
 * so its bytes-parsed figure has to come out *identical* across corpus sizes
 * rather than merely growing slowly.
 */
function writeCorpus(fileCount: number, linesPerFile: number, sessionLines = 100): string[] {
  const dir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let f = 0; f < fileCount; f++) {
    const lines: string[] = [];
    const count = f === 0 ? sessionLines : linesPerFile;
    for (let i = 0; i < count; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          sessionId: `sess-${f}`,
          message: {
            id: `msg-${f}-${i}`,
            model: "test-model",
            usage: { input_tokens: 10, output_tokens: 0 },
            // Padding, so a line resembles a real transcript line in size.
            content: [{ type: "text", text: "x".repeat(400) }],
          },
        }),
      );
    }
    const filePath = path.join(dir, `sess-${f}.jsonl`);
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    paths.push(filePath);
  }
  return paths;
}

/** Total bytes of every transcript this render actually read and parsed. */
function bytesParsed(): number {
  return vi
    .mocked(parseJsonlFile)
    .mock.calls.map((c) => c[0])
    .reduce((sum, p) => sum + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
}

function settingsWith(costSource: Settings["costSource"]): Settings {
  return { ...DEFAULT_SETTINGS, costSource };
}

const SMALL = 200;
const LARGE = 2000; // 10x

describe("cache-miss cost is flat in the day's transcript volume (#94)", () => {
  it("reads nothing but its own session's transcript in the default config", async () => {
    const paths = writeCorpus(8, LARGE);
    const stdin = { session_id: "sess-0", cost: { total_cost_usd: 1 } } as StatusJson;

    await buildRenderContext(stdin, settingsWith("auto"));

    // Its own transcript, and only that one, out of eight.
    expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([paths[0]]);
  });

  it("parses an identical number of bytes on a warm calculated render, at both corpus sizes", async () => {
    const stdin = { session_id: "sess-0", cost: { total_cost_usd: 1 } } as StatusJson;

    // Two renders: the first populates the cache, the second is the one under
    // test. `smallCorpus`/`largeCorpus` differ 10x in everything EXCEPT the
    // session's own transcript, which is pinned at 100 lines by writeCorpus.
    const measureWarm = async (linesPerFile: number): Promise<number> => {
      fs.rmSync(path.join(tmpDir, ".claude"), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, "cache"), { recursive: true, force: true });
      const paths = writeCorpus(8, linesPerFile);
      await buildRenderContext(stdin, settingsWith("calculated"));
      vi.mocked(parseJsonlFile).mockClear();
      const warm = await buildRenderContext(stdin, settingsWith("calculated"));

      // Exactly the session's own transcript, nothing else.
      expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([paths[0]]);
      // Proves calculated mode actually engaged and priced the transcript,
      // not just that the (possibly broken) gate read zero files and still
      // produced a flat — but meaningless — byte count.
      expect(warm.todayCostUsd).toBeGreaterThan(0);
      return bytesParsed();
    };

    const smallWarm = await measureWarm(SMALL);
    const largeWarm = await measureWarm(LARGE);

    // The 10x corpus growth is entirely in files the warm render never touches,
    // so the bytes it parses are not merely similar — they are the same number.
    // This is #94's acceptance criterion, stated deterministically.
    expect(smallWarm).toBeGreaterThan(0);
    expect(largeWarm).toBe(smallWarm);
  });

  it("re-parses only the changed file, whatever the corpus size", async () => {
    const paths = writeCorpus(8, LARGE);
    getTodayAggregate();
    vi.mocked(parseJsonlFile).mockClear();

    fs.appendFileSync(
      paths[3]!,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: { model: "test-model", usage: { input_tokens: 1, output_tokens: 0 } },
      }) + "\n",
    );
    getTodayAggregate();

    expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([paths[3]]);
  });
});
