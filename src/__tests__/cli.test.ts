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
  let originalXdg: string | undefined;
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  function writeEntry(model: string, inputTokens: number, outputTokens = 0): void {
    const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.appendFileSync(
      path.join(projectDir, `${model}.jsonl`),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: model,
        message: { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
      }) + "\n",
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cli-"));
    originalHome = process.env["HOME"];
    originalXdg = process.env["XDG_CACHE_HOME"];
    process.env["HOME"] = tmpDir;
    process.env["XDG_CACHE_HOME"] = tmpDir;
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = originalXdg;
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

  // #103: distinct from the unpriced case above. Two turns on purpose — one
  // under the 200k threshold (10k in / 5k out, standard rate), one over it
  // (250k in / 1k out, premium rate the mocked table doesn't publish). A
  // naive implementation that reported the model's WHOLE token count instead
  // of just its premium-band tokens would print 266.0k here; the correct
  // figure is 251.0k (the premium turn alone). A single-turn fixture could
  // not tell those two behaviours apart.
  it("marks the total approximate and reports the premium-band tokens, not the session total", async () => {
    writeEntry("claude-priced-test", 10_000, 5_000);
    writeEntry("claude-priced-test", 250_000, 1_000);

    await runCli(["today"]);

    const report = lines.join("\n");

    // 1. (approximate), not (partial) — nothing here is unpriced.
    expect(report).toContain("(approximate)");
    expect(report).not.toContain("(partial)");

    // 2. Names the model, states the standard-rate costing and that the real
    // total is higher — and does NOT reuse the unpriced sentence, which would
    // be false: this model's usage IS in the total.
    expect(report).toContain("claude-priced-test");
    expect(report).toMatch(/costed at the standard rate/);
    expect(report).toMatch(/real total is higher/);
    expect(report).not.toMatch(/their usage is missing from the total/);

    // 3. The premium-band total (251.0k), not the session's whole token
    // count for the model (266.0k, which legitimately appears elsewhere in
    // the report — in "Total Tokens" and the "By Model" line — so the check
    // must be scoped to the approximated sentence itself, not the report as
    // a whole).
    const approximatedLine = lines.find((l) => l.includes("billed"));
    expect(approximatedLine, `no approximated sentence found:\n${report}`).toBeDefined();
    expect(approximatedLine).toContain("251.0k");
    expect(approximatedLine).not.toContain("266.0k");

    // The threshold is a fixed constant, rendered as a plain literal, not run
    // through formatTokens (which would print "200.0k").
    expect(approximatedLine).toContain("200k threshold");
  });
});

describe("gccusage setup", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const settingsPath = (): string => path.join(tmpDir, ".claude", "settings.json");
  const backupPath = (): string => `${settingsPath()}.bak`;
  const read = (p: string): string => fs.readFileSync(p, "utf8");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-setup-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds statusLine without disturbing unrelated keys", async () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }),
    );

    await runCli(["setup"]);

    const after = JSON.parse(read(settingsPath()));
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash"] });
    expect(after.statusLine.type).toBe("command");
    expect(after.statusLine.command).toContain("index.js");
  });

  it("writes a backup holding the exact pre-setup bytes", async () => {
    const before = '{\n  "model": "opus"\n}\n';
    fs.writeFileSync(settingsPath(), before);

    await runCli(["setup"]);

    expect(read(backupPath())).toBe(before);
  });

  it("writes settings.json as indented JSON with a trailing newline", async () => {
    await runCli(["setup"]);

    const raw = read(settingsPath());
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "statusLine"');
  });

  it("creates settings.json when none exists, and takes no backup", async () => {
    await runCli(["setup"]);

    expect(JSON.parse(read(settingsPath())).statusLine.type).toBe("command");
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  // #88: each of these previously exited 0 having written nothing (null,
  // scalar) or having silently dropped statusLine (array).
  it.each([
    ["a null document", "null", "not a JSON object"],
    ["a bare string", '"oops"', "not a JSON object"],
    ["an array root", "[]", "not a JSON object"],
    ["malformed JSON", "{oops", "not valid JSON"],
  ])("refuses %s and changes nothing", async (_label, contents, expectedMessage) => {
    fs.writeFileSync(settingsPath(), contents);

    await expect(runCli(["setup"])).rejects.toThrow(expectedMessage);

    expect(read(settingsPath())).toBe(contents);
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it("names the offending file and how to recover", async () => {
    fs.writeFileSync(settingsPath(), "null");

    await expect(runCli(["setup"])).rejects.toThrow(settingsPath());
    await expect(runCli(["setup"])).rejects.toThrow("re-run `gccusage setup`");
  });
});
