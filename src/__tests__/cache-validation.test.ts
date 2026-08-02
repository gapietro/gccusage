import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCache, writeCache } from "../cache/cache-manager.js";
import { trackTurn } from "../data/turn-tracker.js";

/**
 * Every cache file used to be read with `JSON.parse(raw) as SomeType`, a cast
 * that checks nothing at runtime (#92). Verified against the shipped bundle
 * before this change: a turn-count.json containing the four bytes "null"
 * produced an empty statusline and exit 0 — the whole bar, gone.
 */

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cachevalid-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, contents: string): void {
  fs.writeFileSync(path.join(tmpDir, "gccusage", name), contents);
}

function read(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "gccusage", name), "utf-8"));
}

describe("statusline cache validation", () => {
  const HOUR = 3_600_000;

  it("serves a well-formed entry", () => {
    writeCache("bar-output", "s1", 1.25, 120);
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBe("bar-output");
  });

  it("discards an entry whose output is not a string", () => {
    write(
      "statusline-cache.json",
      JSON.stringify({ output: 42, timestamp: Date.now(), sessionId: "s1", costUsd: 1.25, terminalWidth: 120 }),
    );
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });

  it("discards an entry whose timestamp is a string", () => {
    write(
      "statusline-cache.json",
      JSON.stringify({ output: "x", timestamp: String(Date.now()), sessionId: "s1", costUsd: 1.25, terminalWidth: 120 }),
    );
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });

  it("discards a bare null document", () => {
    write("statusline-cache.json", "null");
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });

  it("discards a torn file", () => {
    write("statusline-cache.json", '{"output": "x", "timest');
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });
});

describe("turn counter validation", () => {
  it("counts up across calls in one session", () => {
    expect(trackTurn("s1")).toBe(1);
    expect(trackTurn("s1")).toBe(2);
  });

  // The reproduced blank-bar defect.
  it("rebuilds from a bare null document instead of throwing", () => {
    write("turn-count.json", "null");
    expect(trackTurn("s1")).toBe(1);
  });

  it("rebuilds when count is not a number", () => {
    write("turn-count.json", JSON.stringify({ sessionId: "s1", count: "7" }));
    expect(trackTurn("s1")).toBe(1);
    expect(read("turn-count.json")).toEqual({ sessionId: "s1", count: 1 });
  });

  it("rebuilds from a torn file", () => {
    write("turn-count.json", '{"sessionId": "s1", "cou');
    expect(trackTurn("s1")).toBe(1);
  });
});
