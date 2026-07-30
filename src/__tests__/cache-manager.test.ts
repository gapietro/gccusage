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
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkCache session matching", () => {
  it("returns cached output for the same session", () => {
    writeCache("output-a", "session-a");
    expect(checkCache(60000, "session-a")).toBe("output-a");
  });

  it("misses when the requested session differs", () => {
    writeCache("output-a", "session-a");
    expect(checkCache(60000, "session-b")).toBeNull();
  });

  it("misses when the cache entry has no session but one is requested", () => {
    writeCache("output-a", undefined);
    expect(checkCache(60000, "session-a")).toBeNull();
  });

  it("misses when the cache entry has a session but none is requested", () => {
    writeCache("output-a", "session-a");
    expect(checkCache(60000, undefined)).toBeNull();
  });
});

describe("checkCache cost matching", () => {
  it("returns cached output when the cost is unchanged", () => {
    writeCache("output-a", "session-a", 1.25);
    expect(checkCache(60000, "session-a", 1.25)).toBe("output-a");
  });

  it("misses when the requested cost differs from the cached cost", () => {
    writeCache("output-a", "session-a", 1.25);
    expect(checkCache(60000, "session-a", 2.5)).toBeNull();
  });

  it("misses when the cache entry has no cost but one is requested", () => {
    writeCache("output-a", "session-a", undefined);
    expect(checkCache(60000, "session-a", 1.25)).toBeNull();
  });

  it("misses when the cache entry has a cost but none is requested", () => {
    writeCache("output-a", "session-a", 1.25);
    expect(checkCache(60000, "session-a", undefined)).toBeNull();
  });
});
