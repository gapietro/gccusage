import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellQuote, buildStatusLineCommand, runCli } from "../cli.js";

describe("shellQuote", () => {
  it("wraps plain paths in single quotes", () => {
    expect(shellQuote("/usr/local/bin/node")).toBe("'/usr/local/bin/node'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/Users/o'brien/dist/index.js")).toBe(
      "'/Users/o'\\''brien/dist/index.js'",
    );
  });
});

describe("buildStatusLineCommand", () => {
  it("quotes both the node executable and the script path", () => {
    const cmd = buildStatusLineCommand(
      "/usr/local/bin/node",
      "/Users/dev/Developer Projects/gccusage/dist/index.js",
    );
    expect(cmd).toBe(
      "'/usr/local/bin/node' '/Users/dev/Developer Projects/gccusage/dist/index.js'",
    );
  });
});

// `gccusage today` prices straight from the table, so an unpriced model was
// dropped from both the total and the by-model list with nothing said (#82).
vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({
    "claude-priced-test": {
      inputCostPerToken: 1 / 1_000_000,
      outputCostPerToken: 0,
      cacheCreationCostPerToken: 0,
      cacheReadCostPerToken: 0,
    },
  })),
}));

describe("gccusage today", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  function writeEntry(model: string, inputTokens: number): void {
    const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.appendFileSync(
      path.join(projectDir, `${model}.jsonl`),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: model,
        message: { model, usage: { input_tokens: inputTokens, output_tokens: 0 } },
      }) + "\n",
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cli-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("names the models it could not price", async () => {
    writeEntry("claude-priced-test", 1_000_000);
    writeEntry("claude-unpriced-test", 1_000_000);

    await runCli(["today"]);

    const report = lines.join("\n");
    expect(report).toContain("claude-unpriced-test");
    expect(report).toMatch(/no pricing/i);
  });

  it("says nothing about pricing when every model priced", async () => {
    writeEntry("claude-priced-test", 1_000_000);

    await runCli(["today"]);

    expect(lines.join("\n")).not.toMatch(/no pricing/i);
  });
});
