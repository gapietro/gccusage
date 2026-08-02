import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStatusline } from "../statusline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { stripAnsi } from "../utils/terminal.js";

/**
 * The end-to-end acceptance criterion for #82: with the pricing feed
 * unreachable and no cache, a real priced session must still render a real
 * cost. Nothing here is mocked except the network — the pricing fetcher, the
 * transcript reader, the daily store and the renderer all run for real, which
 * is the point. Mocking `fetchPricing`, as the other pipeline tests do, would
 * skip the exact code path that was broken.
 */

const SESSION_ID = "00000000-0000-4000-8000-0000000000ff";

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

function writeTranscript(model: string): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      message: {
        model,
        // Enough tokens that any real Claude rate rounds to a visible figure.
        usage: { input_tokens: 2_000_000, output_tokens: 500_000 },
      },
    }) + "\n",
  );
}

function renderOffline(model: string): Promise<string> {
  writeTranscript(model);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND — offline");
    }),
  );
  return runStatusline(
    { session_id: SESSION_ID, model: { id: model, display_name: model } },
    { ...DEFAULT_SETTINGS, costSource: "calculated" },
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-offline-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpDir;
  process.env["XDG_CACHE_HOME"] = tmpDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rendering with the pricing feed unreachable", () => {
  it("still shows a real cost for a current model", async () => {
    const bar = stripAnsi(await renderOffline("claude-opus-5"));

    const amounts = [...bar.matchAll(/\$(\d+\.\d{2})/g)].map((m) => Number(m[1]));
    expect(amounts.length, `no cost rendered: ${bar}`).toBeGreaterThan(0);
    // The reported symptom was $0.00 across the board.
    expect(amounts.some((a) => a > 0), `every cost rendered as zero: ${bar}`).toBe(true);
    expect(bar).not.toContain("?");
  });

  it("marks the cost when the model really has no price", async () => {
    const bar = stripAnsi(await renderOffline("claude-not-a-real-model-99"));

    // Not a regression — this is the honest rendering of an unknown model:
    // the figure is flagged rather than passed off as a complete total.
    expect(bar).toMatch(/\$0\.00\?/);
  });
});
