import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCache, writeCache } from "../cache/cache-manager.js";

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cache-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Which inputs belong in the key is computeCacheKey's contract, tested in
// cache-key.test.ts. Here the entry either matches the key it was written
// under or it does not.
describe("checkCache key matching", () => {
  it("returns cached output for the key it was written under", () => {
    writeCache("output-a", "key-a");
    expect(checkCache(60000, "key-a")).toBe("output-a");
  });

  it("misses when the requested key differs", () => {
    writeCache("output-a", "key-a");
    expect(checkCache(60000, "key-b")).toBeNull();
  });

  it("misses once the entry is older than the TTL", () => {
    writeCache("output-a", "key-a");

    const cachePath = path.join(tmpDir, "gccusage", "statusline-cache.json");
    const entry = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, unknown>;
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ ...entry, timestamp: Date.now() - 61000 }),
    );

    expect(checkCache(60000, "key-a")).toBeNull();
    expect(checkCache(120000, "key-a")).toBe("output-a");
  });

  it("misses on an entry written by the previous key format", () => {
    // (sessionId, costUsd, terminalWidth) with no `key` — served stale for
    // every input outside that triple (#96), so it must not be honoured.
    fs.writeFileSync(
      path.join(tmpDir, "gccusage", "statusline-cache.json"),
      JSON.stringify({
        output: "stale-bar",
        timestamp: Date.now(),
        sessionId: "session-a",
        costUsd: 1.25,
        terminalWidth: 120,
      }),
    );

    expect(checkCache(60000, "key-a")).toBeNull();
  });
});
