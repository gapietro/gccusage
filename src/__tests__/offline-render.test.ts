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

function writeTranscript(model: string, inputTokens: number, outputTokens: number): void {
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
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }) + "\n",
  );
}

function renderOffline(model: string, inputTokens: number, outputTokens: number): Promise<string> {
  writeTranscript(model, inputTokens, outputTokens);
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
    // 150k input, 50k output: enough tokens that any real Claude rate rounds
    // to a visible figure, and deliberately below the 200k premium prompt
    // threshold (PREMIUM_PROMPT_THRESHOLD, output tokens don't count toward
    // it) so this session is genuinely standard-rate. If this crossed the
    // threshold the "not.toContain('?')" assertion below would depend on
    // claude-opus-5 carrying a published premium rate, which it does not
    // (#103) — that would make this test fail for a reason unrelated to #82.
    const bar = stripAnsi(await renderOffline("claude-opus-5", 150_000, 50_000));

    const amounts = [...bar.matchAll(/\$(\d+\.\d{2})/g)].map((m) => Number(m[1]));
    expect(amounts.length, `no cost rendered: ${bar}`).toBeGreaterThan(0);
    // The reported symptom was $0.00 across the board.
    expect(amounts.some((a) => a > 0), `every cost rendered as zero: ${bar}`).toBe(true);
    expect(bar).not.toContain("?");
  });

  it("marks the cost when the model really has no price", async () => {
    const bar = stripAnsi(await renderOffline("claude-not-a-real-model-99", 2_000_000, 500_000));

    // Not a regression — this is the honest rendering of an unknown model:
    // the figure is flagged rather than passed off as a complete total.
    expect(bar).toMatch(/\$0\.00\?/);
  });

  // Distinct from the test above: that one renders $0.00? because nothing
  // could be priced at all. This one renders a real, non-zero figure that is
  // a LOWER BOUND — the model IS priced, but claude-opus-5 has no published
  // premium rate (#103), so tokens above the 200k threshold are costed at
  // the standard rate. Do not fold these two cases into one test: "no price"
  // and "approximated price" are different failure modes with different
  // wording, and collapsing them would hide a regression that turned one
  // into the other. This file is the only place the whole render path runs
  // unmocked, so it is the only true end-to-end acceptance test for #103.
  it("marks the cost when a long-context session outran the published rates", async () => {
    const bar = stripAnsi(await renderOffline("claude-opus-5", 300_000, 1_000));

    expect(bar).toMatch(/\$\d+\.\d{2}\?/);
    expect(bar).not.toMatch(/\$0\.00\?/);
  });
});
