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

// The key used to be (sessionId, costUsd, terminalWidth), so any other input
// that changed the bar was served stale for up to the TTL (#96). vim.mode is
// the sharpest case: it ships in the default layout and changes with no
// accompanying cost change.
describe("cache key covers the inputs that change the bar (#96)", () => {
  const base = {
    session_id: "session-a",
    cost: { total_cost_usd: 1.25 },
    vim: { mode: "NORMAL" },
    workspace: { project_dir: "/tmp/project-one" },
    context_window: { used_percentage: 40 },
  };

  it("re-renders when vim.mode changes within the TTL", async () => {
    const first = await runStatusline(base, DEFAULT_SETTINGS);

    const second = await runStatusline(
      { ...base, vim: { mode: "INSERT" } },
      DEFAULT_SETTINGS,
    );

    expect(second).not.toBe(first);
  });

  it("re-renders when the project directory changes within the TTL", async () => {
    const first = await runStatusline(base, DEFAULT_SETTINGS);

    const second = await runStatusline(
      { ...base, workspace: { project_dir: "/tmp/project-two" } },
      DEFAULT_SETTINGS,
    );

    expect(second).not.toBe(first);
  });

  it("re-renders when the context percentage changes within the TTL", async () => {
    const first = await runStatusline(base, DEFAULT_SETTINGS);

    const second = await runStatusline(
      { ...base, context_window: { used_percentage: 41 } },
      DEFAULT_SETTINGS,
    );

    expect(second).not.toBe(first);
  });

  // The counterweight to the three above: the session timers tick on every
  // spawn, so keying on them would miss every time and re-read the whole
  // transcript set on each render (#94). Their staleness is the TTL's job.
  it("serves the cache while only the session timers tick", async () => {
    const first = await runStatusline(
      { ...base, cost: { ...base.cost, total_duration_ms: 60000, total_api_duration_ms: 9000 } },
      DEFAULT_SETTINGS,
    );

    const second = await runStatusline(
      { ...base, cost: { ...base.cost, total_duration_ms: 61000, total_api_duration_ms: 9400 } },
      DEFAULT_SETTINGS,
    );

    expect(second).toBe(first);
  });
});
