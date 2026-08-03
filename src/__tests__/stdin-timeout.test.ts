import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readStdin,
  resolveTimeoutMs,
  DEFAULT_STDIN_TIMEOUT_MS,
} from "../data/stdin-reader.js";

/**
 * `readStdin` sat at 0% coverage because it read the global `process.stdin`
 * with no seam (#95 lists it as one of six such files). The stream and the
 * deadline are now parameters with production defaults, so the whole of it is
 * reachable in-process without spawning anything.
 */
describe("readStdin", () => {
  it("reports a timeout when nothing ever arrives", async () => {
    const stream = new PassThrough();

    const result = await readStdin(stream, 50);

    expect(result.timedOut).toBe(true);
    expect(result.raw).toBe("");
    // The applied deadline is echoed back rather than re-derived by the
    // caller, so the rendered message can name the real figure.
    expect(result.timeoutMs).toBe(50);
  });

  it("reports a timeout when the payload is truncated, keeping the partial bytes", async () => {
    const stream = new PassThrough();
    stream.write('{"cost":{"total_cost_usd":7.5}');   // no closing brace, never ends

    const result = await readStdin(stream, 50);

    expect(result.timedOut).toBe(true);
    expect(result.raw).toBe('{"cost":{"total_cost_usd":7.5}');
  });

  it("resolves immediately on a prompt writer, well before the deadline", async () => {
    const stream = new PassThrough();
    const payload = '{"cost":{"total_cost_usd":7.5}}';
    stream.end(payload);

    const started = Date.now();
    const result = await readStdin(stream, 5000);
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(false);
    expect(result.raw).toBe(payload);
    // Guards against the timer quietly becoming the resolution path: if `end`
    // stopped settling the promise, this would take 5s instead of ~0ms.
    expect(elapsed).toBeLessThan(1000);
  });

  it("rejects when the stream errors", async () => {
    const stream = new PassThrough();
    const failure = new Error("boom");
    queueMicrotask(() => stream.destroy(failure));

    await expect(readStdin(stream, 5000)).rejects.toThrow("boom");
  });
});

describe("resolveTimeoutMs", () => {
  const KEY = "GCCUSAGE_STDIN_TIMEOUT_MS";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("defaults to 5s when unset", () => {
    delete process.env[KEY];
    expect(resolveTimeoutMs()).toBe(DEFAULT_STDIN_TIMEOUT_MS);
    expect(DEFAULT_STDIN_TIMEOUT_MS).toBe(5000);
  });

  it("honours a valid override", () => {
    process.env[KEY] = "200";
    expect(resolveTimeoutMs()).toBe(200);
  });

  it.each(["", "   ", "abc", "0", "-1", "1.5", "Infinity"])(
    "falls back to the default on the unusable value %j",
    (value) => {
      process.env[KEY] = value;
      // A coerced NaN would make setTimeout fire immediately and turn every
      // single render into the degraded line — the loudest possible failure
      // from the quietest possible typo. Same posture as getTerminalWidth's
      // handling of a bad COLUMNS (src/utils/terminal.ts:28-32).
      expect(resolveTimeoutMs()).toBe(DEFAULT_STDIN_TIMEOUT_MS);
    },
  );
});

// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

const PAYLOAD = JSON.stringify({
  session_id: "00000000-0000-4000-8000-0000000000fe",
  model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
  workspace: { current_dir: "/tmp/x", project_dir: "/tmp/x" },
  cost: {
    total_cost_usd: 7.5,
    total_duration_ms: 60_000,
    total_api_duration_ms: 1000,
    total_lines_added: 0,
    total_lines_removed: 0,
  },
  context_window: {
    used_percentage: 42,
    context_window_size: 200_000,
    current_usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 90,
    },
    total_input_tokens: 100,
    total_output_tokens: 50,
  },
});

describe.skipIf(!distExists)("slow stdin against the shipped bundle", () => {
  let dir: string;

  beforeEach(() => {
    // A fresh HOME and cache per test: no daily store carried between cases,
    // and no statusline cache hit serving one test's bar to another.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-stdin-"));
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(opts: {
    payload: string | null;
    writeAfterMs: number;
    timeoutMs: number;
  }): Promise<{ stdout: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DIST], {
        env: {
          ...process.env,
          HOME: dir,
          XDG_CACHE_HOME: path.join(dir, "cache"),
          GCCUSAGE_STDIN_TIMEOUT_MS: String(opts.timeoutMs),
          COLUMNS: "120",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ stdout, status }));

      // On the timeout path the child has already destroyed its stdin by the
      // time we write, so the pipe is gone and the write raises EPIPE. That is
      // the expected outcome of the feature, not a failure — without this
      // handler it surfaces as an unhandled 'error' event and kills the runner.
      child.stdin.on("error", () => {});

      setTimeout(() => {
        if (opts.payload === null) child.stdin.end();
        else child.stdin.end(opts.payload);
      }, opts.writeAfterMs);
    });
  }

  it("shows the degraded line instead of a zeroed bar when the writer is slow", async () => {
    const { stdout, status } = await run({
      payload: PAYLOAD,
      writeAfterMs: 500,
      timeoutMs: 200,
    });

    expect(stdout).toContain("⚠ gccusage");
    expect(stdout).toContain("within 200ms");
    // The issue's literal acceptance criterion. Before the fix this rendered
    // "$0.00" beside a Today: figure read from the daily store.
    expect(stdout).not.toContain("$0.00");
    // Claude Code discards output from a non-zero exit, so the message would
    // never reach the user if this were anything but 0.
    expect(status).toBe(0);
    // Returning before runStatusline must leave the cache alone. Otherwise the
    // degraded bar is written under the empty payload's key and a second
    // timeout inside the TTL serves it back without reading stdin at all.
    expect(
      fs.existsSync(path.join(dir, "cache", "gccusage", "statusline-cache.json")),
    ).toBe(false);
  });

  it("renders the normal bar when the payload arrives promptly", async () => {
    const { stdout, status } = await run({
      payload: PAYLOAD,
      writeAfterMs: 0,
      timeoutMs: 2000,
    });

    // Guards against the fix firing on the happy path.
    expect(stdout).not.toContain("⚠");
    expect(stdout).toContain("$7.50");
    expect(status).toBe(0);
  });

  it("stays silent when stdin closes cleanly having sent nothing", async () => {
    const { stdout, status } = await run({
      payload: null,
      writeAfterMs: 0,
      timeoutMs: 2000,
    });

    // Deliberately unchanged: this is `gccusage < /dev/null` and pipe-based
    // smoke checks. Pinned so a later tidy-up cannot quietly widen the
    // degraded line to cover a case we decided to leave alone.
    expect(stdout).not.toContain("⚠");
    expect(stdout).toContain("$0.00");
    expect(status).toBe(0);
  });
});
