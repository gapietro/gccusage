import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { customCommandWidget } from "../widgets/custom-command.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A shell command that prints 1, 2, 3, ... on successive runs, so the number
 * of times the widget actually executed is readable straight off the bar.
 * Each call gets its own counter file, and therefore its own command string —
 * the widget's cache is keyed on the command text alone, so two tests sharing
 * one command string would share one cache entry.
 */
function countingCommand(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cmd-"));
  tmpdirs.push(dir);
  const counter = path.join(dir, "counter");
  return `printf x >> '${counter}'; wc -c < '${counter}' | tr -d ' '`;
}

function makeContext(): RenderContext {
  return {
    stdin: { model: "claude-sonnet-4-20250514" },
    metrics: {
      byModel: new Map(),
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
      },
    },
    block: null,
    burnRate: null,
    pricing: {},
    sessionCostUsd: 0,
    todayCostUsd: 0,
    costByModel: new Map(),
    unpricedModels: [],
    approximatedModels: [],
    sessionCostUncertain: false,
    todayCostUncertain: false,
    sessionStartTime: null,
    terminalWidth: 120,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: 0,
  };
}

function renderTwice(config: WidgetConfig): [string | undefined, string | undefined] {
  const context = makeContext();
  return [
    customCommandWidget.render(context, config)?.text,
    customCommandWidget.render(context, config)?.text,
  ];
}

describe("customCommandWidget cache TTL", () => {
  it("caches the output for 30s when no TTL is configured", () => {
    const [first, second] = renderTwice({ type: "custom-command", command: countingCommand() });

    expect(first).toBe("1");
    expect(second).toBe("1");
  });

  it("re-runs the command when cacheTtlMs is 0", () => {
    const [first, second] = renderTwice({
      type: "custom-command",
      command: countingCommand(),
      cacheTtlMs: 0,
    });

    expect(first).toBe("1");
    expect(second).toBe("2");
  });

  it("serves the cache within cacheTtlMs", () => {
    const [first, second] = renderTwice({
      type: "custom-command",
      command: countingCommand(),
      cacheTtlMs: 60_000,
    });

    expect(first).toBe("1");
    expect(second).toBe("1");
  });

  it("ignores maxWidth, which it used to read as the TTL (#97)", () => {
    // Before #97 this widget read `maxWidth` as its cache TTL, so a user who
    // followed the JSON Schema's "Maximum width for this widget" and set
    // `maxWidth: 20` got a 20ms TTL — the cache never hit and the shell
    // command ran on every render. The field is gone now; a config that still
    // carries it must fall back to the default TTL, not to no caching.
    const [first, second] = renderTwice({
      type: "custom-command",
      command: countingCommand(),
      maxWidth: 0,
    } as WidgetConfig);

    expect(first).toBe("1");
    expect(second).toBe("1");
  });
});
