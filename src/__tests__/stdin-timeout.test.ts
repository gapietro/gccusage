import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
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
