import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { layoutIncludesWidget } from "../config/layout.js";
import { buildRenderContext } from "../data/pipeline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { StatusJson } from "../types/status-json.js";

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({})),
  getPricingForRender: vi.fn(() => ({ pricing: {}, stale: false })),
}));

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

function turnsDirExists(): boolean {
  return fs.existsSync(path.join(tmpDir, "gccusage", "turns"));
}

function withWidget(type: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    lines: [{ widgets: [{ type }], flex: "left" }],
  };
}

const STDIN: StatusJson = {
  session_id: "gate-session",
  model: { id: "claude-opus-4-5", display_name: "Opus" },
  cost: { total_cost_usd: 1.5 },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-gate-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("layoutIncludesWidget", () => {
  it("finds a widget on the first line", () => {
    expect(layoutIncludesWidget(withWidget("turn-counter"), "turn-counter")).toBe(true);
  });

  it("finds a widget on a later line", () => {
    // git-branch is on the SECOND default line, so a first-line-only scan
    // would report false here.
    expect(layoutIncludesWidget(DEFAULT_SETTINGS, "git-branch")).toBe(true);
  });

  it("reports false for a widget in no line", () => {
    expect(layoutIncludesWidget(DEFAULT_SETTINGS, "turn-counter")).toBe(false);
  });

  it("reports false for an empty layout", () => {
    expect(layoutIncludesWidget({ ...DEFAULT_SETTINGS, lines: [] }, "turn-counter")).toBe(
      false,
    );
  });
});

describe("turn tracking gate", () => {
  it("writes no turn shard when the layout has no turn-counter", async () => {
    const context = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(turnsDirExists()).toBe(false);
    expect(context.turnCount).toBe(0);
  });

  it("writes a turn shard when the layout has a turn-counter", async () => {
    const context = await buildRenderContext(STDIN, withWidget("turn-counter"));
    expect(turnsDirExists()).toBe(true);
    expect(context.turnCount).toBe(1);
  });

  it("keeps counting across renders once enabled", async () => {
    const settings = withWidget("turn-counter");
    await buildRenderContext(STDIN, settings);
    const second = await buildRenderContext(STDIN, settings);
    expect(second.turnCount).toBe(2);
  });
});
