import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { StatusJson } from "../types/status-json.js";

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({})),
  getPricingForRender: vi.fn(() => ({ pricing: {}, stale: false })),
}));

const SESSION_ID = "turn-count-session";

const STDIN: StatusJson = {
  session_id: SESSION_ID,
  model: { id: "claude-opus-4-5", display_name: "Opus" },
  cost: { total_cost_usd: 1.5 },
};

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

/**
 * A transcript in the real shape: three human prompts buried in the tool
 * results, task notifications, meta lines and assistant responses that make up
 * the other ~95% of a session's lines.
 */
function writeTranscript(): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const stamp = (n: number) => `2026-08-04T10:${String(n).padStart(2, "0")}:00.000Z`;
  const lines = [
    { type: "user", origin: { kind: "human" }, promptSource: "typed",
      message: { role: "user", content: "first" }, timestamp: stamp(1), sessionId: SESSION_ID },
    { type: "assistant", message: { id: "msg_1", model: "claude-opus-4-5",
      usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: stamp(2), sessionId: SESSION_ID },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      timestamp: stamp(3), sessionId: SESSION_ID },
    { type: "assistant", message: { id: "msg_2", model: "claude-opus-4-5",
      usage: { input_tokens: 20, output_tokens: 5 } }, timestamp: stamp(4), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "task-notification" }, promptSource: "system",
      message: { role: "user", content: "<task-notification>done</task-notification>" },
      timestamp: stamp(5), sessionId: SESSION_ID },
    { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat/>" },
      timestamp: stamp(6), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "human" }, promptSource: "typed",
      message: { role: "user", content: "second" }, timestamp: stamp(7), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "coordinator" }, isSidechain: true,
      message: { role: "user", content: "subagent task" }, timestamp: stamp(8), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "human" }, promptSource: "suggestion_accepted",
      message: { role: "user", content: "third" }, timestamp: stamp(9), sessionId: SESSION_ID },
  ];

  fs.writeFileSync(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-turncount-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
  writeTranscript();
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("turnCount is derived, not accumulated (#129)", () => {
  // DEFAULT_SETTINGS has no turn-counter widget. The old layout gate would
  // have suppressed this to 0; removing it means the count is produced
  // regardless of which widgets are configured — counting an in-memory array
  // is free, so there is nothing left to charge only to turn-counter users.
  it("counts the three human prompts, not the nine lines", async () => {
    const context = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(context.turnCount).toBe(3);
  });

  // The #129 regression itself. The old trackTurn incremented a persisted
  // counter once per buildRenderContext call, so this returned 1 then 2 then 3
  // for a transcript that never changed.
  it("does not change across repeated renders of the same transcript", async () => {
    const first = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    const second = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    const third = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect([first.turnCount, second.turnCount, third.turnCount]).toEqual([3, 3, 3]);
  });

  it("writes no turn store to disk", async () => {
    await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(fs.existsSync(path.join(tmpDir, "gccusage", "turns"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "gccusage", "turn-count.json"))).toBe(false);
  });

  it("reports 0 when the session has no transcript at all", async () => {
    const context = await buildRenderContext(
      { ...STDIN, session_id: "no-such-session" },
      DEFAULT_SETTINGS,
    );
    expect(context.turnCount).toBe(0);
  });
});
