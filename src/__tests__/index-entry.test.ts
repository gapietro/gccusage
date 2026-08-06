import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `src/index.ts` sat at 0% coverage: it is the only module that runs on import
 * rather than on call, so nothing could reach it without executing it (#95).
 * That is exactly why it needs the tests — every branch in it is a decision
 * about what the user sees when something has already gone wrong, and four of
 * the five were written in response to a shipped bug (#83, #87, #88).
 *
 * These import the real entry module with its five collaborators stubbed,
 * rather than testing an extracted `main()`. The module's top-level
 * `main().catch(...)` IS the global error handler the audit named, and moving
 * the body elsewhere to make it testable would have left that line untested in
 * the one file that cannot afford it.
 */

const ENTRY = "../index.js";

interface Harness {
  stdout: string[];
  stderr: string[];
  exitCalls: number[];
  readStdin: ReturnType<typeof vi.fn>;
  parseStatusJson: ReturnType<typeof vi.fn>;
  loadSettings: ReturnType<typeof vi.fn>;
  runStatusline: ReturnType<typeof vi.fn>;
  runCli: ReturnType<typeof vi.fn>;
}

interface Options {
  argv?: string[];
  isTTY?: boolean;
  settings?: { settings: unknown; error?: string };
  stdin?: { raw: string; timedOut: boolean; timeoutMs: number };
  parsed?: { stdin: unknown; error?: string };
  statusline?: () => Promise<string>;
  cli?: () => Promise<void>;
  loadSettingsThrows?: Error;
  stdinThrows?: unknown;
}

let restoreExitCode: number | string | null | undefined;
let restoreArgv: string[];
let restoreIsTTY: boolean | undefined;
let restoreDebug: string | undefined;

beforeEach(() => {
  restoreExitCode = process.exitCode;
  restoreArgv = process.argv;
  restoreIsTTY = process.stdin.isTTY;
  restoreDebug = process.env["GCCUSAGE_DEBUG"];
});

afterEach(() => {
  // The OPS-006 tests set and unset this. Leaking it either way would turn the
  // "stays silent by default" test into a coin flip on file ordering.
  if (restoreDebug === undefined) delete process.env["GCCUSAGE_DEBUG"];
  else process.env["GCCUSAGE_DEBUG"] = restoreDebug;

  // Load-bearing: index.ts sets process.exitCode = 1 on the CLI-failure path,
  // and leaving it set would fail the whole vitest run from a passing test.
  process.exitCode = restoreExitCode;
  process.argv = restoreArgv;
  Object.defineProperty(process.stdin, "isTTY", {
    value: restoreIsTTY,
    configurable: true,
  });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function runEntry(options: Options = {}): Promise<Harness> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCalls: number[] = [];

  const readStdin = vi.fn(async () => {
    if ("stdinThrows" in options) throw options.stdinThrows;
    return options.stdin ?? { raw: "{}", timedOut: false, timeoutMs: 5000 };
  });
  const parseStatusJson = vi.fn(() => options.parsed ?? { stdin: { session_id: "s" } });
  const loadSettings = vi.fn(() => {
    if (options.loadSettingsThrows) throw options.loadSettingsThrows;
    return options.settings ?? { settings: { theme: "default" } };
  });
  const getConfigPath = vi.fn(() => "/config/settings.json");
  const runStatusline = vi.fn(options.statusline ?? (async () => "THE BAR"));
  const runCli = vi.fn(options.cli ?? (async () => {}));

  vi.doMock("../data/stdin-reader.js", () => ({ readStdin, parseStatusJson }));
  vi.doMock("../config/loader.js", () => ({ loadSettings, getConfigPath }));
  vi.doMock("../config/error-line.js", () => ({
    formatConfigError: (error: string, path: string) => `CONFIG_ERROR(${error}@${path})`,
    formatStdinError: (error: string) => `STDIN_ERROR(${error})`,
    formatStdinTimeout: (ms: number) => `STDIN_TIMEOUT(${ms})`,
    formatStdinReadError: (error: string) => `STDIN_READ_ERROR(${error})`,
  }));
  vi.doMock("../statusline.js", () => ({ runStatusline }));
  vi.doMock("../cli.js", () => ({ runCli }));

  process.argv = ["node", "gccusage", ...(options.argv ?? [])];
  Object.defineProperty(process.stdin, "isTTY", {
    value: options.isTTY ?? false,
    configurable: true,
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as never);

  process.exitCode = undefined;
  await import(ENTRY);
  // The module body kicks off an async main() and returns before it settles,
  // so wait for the observable effect rather than guessing a tick count.
  await vi.waitFor(() => {
    expect(stdout.length + stderr.length + exitCalls.length).toBeGreaterThan(0);
  });

  return { stdout, stderr, exitCalls, readStdin, parseStatusJson, loadSettings, runStatusline, runCli };
}

describe("entry point: CLI mode", () => {
  it("hands the arguments to the CLI and never touches the statusline path", async () => {
    const h = await runEntry({ argv: ["setup"], cli: async () => { console.error("ran"); } });

    expect(h.runCli).toHaveBeenCalledWith(["setup"]);
    expect(h.runStatusline).not.toHaveBeenCalled();
    expect(h.loadSettings).not.toHaveBeenCalled();
    expect(h.readStdin).not.toHaveBeenCalled();
  });

  it("reports a CLI failure on stderr and exits non-zero", async () => {
    // The blanket catch below is graceful degradation for statusline mode. It
    // once applied here too, which made `setup` report success having done
    // nothing (#88).
    const h = await runEntry({
      argv: ["setup"],
      cli: async () => {
        throw new Error("settings.json is not a JSON object");
      },
    });

    expect(h.stderr).toEqual(["gccusage: settings.json is not a JSON object"]);
    expect(process.exitCode).toBe(1);
  });

  it("stringifies a non-Error throw rather than printing [object Object]", async () => {
    const h = await runEntry({
      argv: ["today"],
      cli: async () => {
        throw "plain string rejection";
      },
    });

    expect(h.stderr).toEqual(["gccusage: plain string rejection"]);
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode instead of calling process.exit, so stderr can drain", async () => {
    // process.exit(1) here truncated the message on macOS, where a write to a
    // pipe is asynchronous.
    const h = await runEntry({
      argv: ["setup"],
      cli: async () => {
        throw new Error("boom");
      },
    });

    expect(h.exitCalls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code alone when the CLI succeeds", async () => {
    const h = await runEntry({ argv: ["help"], cli: async () => { console.error("help text"); } });

    expect(process.exitCode).toBeUndefined();
    expect(h.exitCalls).toEqual([]);
  });
});

describe("entry point: statusline mode", () => {
  it("writes the rendered bar on the happy path", async () => {
    const h = await runEntry();

    expect(h.stdout).toEqual(["THE BAR"]);
    expect(h.runStatusline).toHaveBeenCalledTimes(1);
  });

  it("replaces the bar with the config error and renders nothing", async () => {
    // Returning before runStatusline is what keeps the statusline cache
    // untouched, so a stale bar is never served over the error and the first
    // prompt after a fix renders normally.
    const h = await runEntry({ settings: { settings: {}, error: "unknown theme 'blurple'" } });

    expect(h.stdout).toEqual(["CONFIG_ERROR(unknown theme 'blurple'@/config/settings.json)"]);
    expect(h.runStatusline).not.toHaveBeenCalled();
    expect(h.readStdin).not.toHaveBeenCalled();
  });

  it("reports a stdin timeout without parsing what arrived", async () => {
    // Partial bytes report a timeout rather than being parsed: Claude Code
    // end()s stdin immediately after writing, so bytes without an end mean
    // truncation, and "not valid JSON" would misdiagnose it (#87).
    const h = await runEntry({
      stdin: { raw: '{"session_id":"trunc', timedOut: true, timeoutMs: 5000 },
    });

    expect(h.stdout).toEqual(["STDIN_TIMEOUT(5000)"]);
    expect(h.parseStatusJson).not.toHaveBeenCalled();
    expect(h.runStatusline).not.toHaveBeenCalled();
  });

  it("reports an unusable payload instead of rendering a confident $0.00 bar", async () => {
    // A bad FIELD is absorbed by the schema and costs only that field; an
    // error here means the payload was unusable as a whole (#83).
    const h = await runEntry({ parsed: { stdin: null, error: "stdin is not valid JSON" } });

    expect(h.stdout).toEqual(["STDIN_ERROR(stdin is not valid JSON)"]);
    expect(h.runStatusline).not.toHaveBeenCalled();
  });

  it("skips the stdin read on a TTY and renders from an empty payload", async () => {
    const h = await runEntry({ isTTY: true });

    expect(h.readStdin).not.toHaveBeenCalled();
    expect(h.parseStatusJson).toHaveBeenCalledWith("");
    expect(h.stdout).toEqual(["THE BAR"]);
  });

  it("passes the raw stdin payload through to the parser", async () => {
    const raw = '{"session_id":"abc"}';
    const h = await runEntry({ stdin: { raw, timedOut: false, timeoutMs: 5000 } });

    expect(h.parseStatusJson).toHaveBeenCalledWith(raw);
  });
});

describe("entry point: stdin stream failure (REL-004)", () => {
  it("renders a diagnostic instead of letting the rejection blank the bar", async () => {
    // Before this, the rejection propagated to main().catch(), which writes
    // nothing — and empty stdout makes Claude Code erase the bar rather than
    // keep the previous one. Every other unusable-input path already rendered
    // a line; this was the last one that did not.
    const h = await runEntry({ stdinThrows: new Error("EIO: i/o error, read") });

    expect(h.stdout).toEqual(["STDIN_READ_ERROR(EIO: i/o error, read)"]);
    // Claude Code discards output from a non-zero exit, so the message would
    // never reach the user if this exited 1.
    expect(h.exitCalls).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not render or cache anything past the failed read", async () => {
    const h = await runEntry({ stdinThrows: new Error("ECONNRESET") });

    // This guards a DIFFERENT regression from the two tests around it, and the
    // distinction is worth stating because it passes against the pre-fix code:
    // there the rejection skipped these calls too, by escaping the function
    // entirely. What it catches is catch-then-continue — handling the error and
    // then falling through with an empty payload, which would render the
    // degraded bar AND write it to the statusline cache under the empty
    // payload's key, so the next render inside the TTL serves it back without
    // reading stdin at all. Verified by that exact sabotage.
    expect(h.parseStatusJson).not.toHaveBeenCalled();
    expect(h.runStatusline).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error rejection rather than printing [object Object]", async () => {
    const h = await runEntry({ stdinThrows: "just a string" });

    expect(h.stdout).toEqual(["STDIN_READ_ERROR(just a string)"]);
  });
});

describe("entry point: global error handler", () => {
  it("explains the swallowed failure on stderr under GCCUSAGE_DEBUG (OPS-006)", async () => {
    // The whole point of the flag: without it this failure produces no output
    // at all, and Claude Code erases the bar on empty stdout, so the tool looks
    // uninstalled rather than broken. stderr is the right channel because
    // stdout IS the bar.
    process.env["GCCUSAGE_DEBUG"] = "1";
    const h = await runEntry({
      statusline: async () => {
        throw new Error("pipeline exploded");
      },
    });

    expect(h.stderr.join("\n")).toContain("pipeline exploded");
    expect(h.stderr.join("\n")).toContain("gccusage: render failed");
    // Still degrades identically — the flag adds a diagnosis, it does not
    // change what the user's prompt does.
    expect(h.exitCalls).toEqual([0]);
    expect(h.stdout).toEqual([]);
  });

  it("stays completely silent when GCCUSAGE_DEBUG is unset", async () => {
    delete process.env["GCCUSAGE_DEBUG"];
    const h = await runEntry({
      statusline: async () => {
        throw new Error("pipeline exploded");
      },
    });

    // Guards the default: a stack trace reaching stderr unconditionally is the
    // failure this handler exists to prevent, on any host that surfaces it.
    expect(h.stderr).toEqual([]);
  });

  it("degrades to exit(0) with no output when the render throws", async () => {
    // Claude Code erases the whole bar on empty output, which is the intended
    // degradation: a missing statusline beats a stack trace in the prompt.
    const h = await runEntry({
      statusline: async () => {
        throw new Error("pipeline exploded");
      },
    });

    expect(h.exitCalls).toEqual([0]);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it("degrades the same way when the failure precedes any output", async () => {
    // The two failure sites differ: this one throws before a single byte has
    // been written, the one above throws after the config and stdin gates
    // have already passed. Both must reach exit(0) rather than a stack trace.
    const h = await runEntry({
      loadSettingsThrows: new Error("HOME is unreadable"),
    });

    expect(h.exitCalls).toEqual([0]);
    expect(h.stdout).toEqual([]);
  });
});
