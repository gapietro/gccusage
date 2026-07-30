import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStatusline } from "../statusline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";

// buildRenderContext reads JSONL transcripts and fetches pricing over the
// network — stub the render boundary so tests stay hermetic. Each render
// produces a distinct output so cache hits are observable in what
// runStatusline returns.
let renderCount = 0;
vi.mock("../data/pipeline.js", () => ({
  buildRenderContext: vi.fn(async () => ({})),
}));
vi.mock("../render/renderer.js", () => ({
  renderStatusline: vi.fn(() => `rendered-${++renderCount}`),
}));

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-statusline-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runStatusline caching", () => {
  it("serves the cached render while session and cost are unchanged", async () => {
    const stdin = { session_id: "session-a", cost: { total_cost_usd: 1.25 } };

    const first = await runStatusline(stdin, DEFAULT_SETTINGS);
    const second = await runStatusline(stdin, DEFAULT_SETTINGS);

    expect(second).toBe(first);
  });

  it("re-renders when the stdin cost changes within the TTL", async () => {
    const first = await runStatusline(
      { session_id: "session-a", cost: { total_cost_usd: 1.25 } },
      DEFAULT_SETTINGS,
    );

    const second = await runStatusline(
      { session_id: "session-a", cost: { total_cost_usd: 2.5 } },
      DEFAULT_SETTINGS,
    );

    expect(second).not.toBe(first);
  });

  it("re-renders when the session changes within the TTL", async () => {
    const first = await runStatusline(
      { session_id: "session-a", cost: { total_cost_usd: 1.25 } },
      DEFAULT_SETTINGS,
    );

    const second = await runStatusline(
      { session_id: "session-b", cost: { total_cost_usd: 1.25 } },
      DEFAULT_SETTINGS,
    );

    expect(second).not.toBe(first);
  });
});
