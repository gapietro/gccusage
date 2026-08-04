import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackTurn } from "../data/turn-tracker.js";

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

function turnsDir(): string {
  return path.join(tmpDir, "gccusage", "turns");
}

function shardFiles(): string[] {
  try {
    return fs.readdirSync(turnsDir()).sort();
  } catch {
    return [];
  }
}

function writeShard(name: string, contents: unknown): void {
  fs.mkdirSync(turnsDir(), { recursive: true });
  fs.writeFileSync(
    path.join(turnsDir(), name),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-turns-"));
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

describe("trackTurn", () => {
  it("returns 0 and writes nothing without a session id", () => {
    expect(trackTurn(undefined)).toBe(0);
    expect(shardFiles()).toEqual([]);
  });

  it("counts up across calls in one session", () => {
    expect(trackTurn("s1")).toBe(1);
    expect(trackTurn("s1")).toBe(2);
    expect(trackTurn("s1")).toBe(3);
  });

  it("writes one shard per session, named for the session id", () => {
    trackTurn("s1");
    trackTurn("s2");
    expect(shardFiles()).toEqual(["s1.json", "s2.json"]);
  });

  // THE REGRESSION TEST for the single-global-slot defect (#99). Before
  // sharding, an interleaved second session reset the file on every
  // alternating call, pinning both counters at 1.
  it("keeps concurrent sessions' counts independent when interleaved", () => {
    expect(trackTurn("alpha")).toBe(1);
    expect(trackTurn("beta")).toBe(1);
    expect(trackTurn("alpha")).toBe(2);
    expect(trackTurn("beta")).toBe(2);
    expect(trackTurn("alpha")).toBe(3);
    expect(trackTurn("beta")).toBe(3);
  });

  it("keeps an unsafe session id inside the turns directory", () => {
    expect(trackTurn("../../etc/passwd")).toBe(1);
    const files = shardFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it("restarts the count when a shard holds a different session id", () => {
    // Only reachable via a hash collision, but the guard is what makes the
    // hashed key safe to reuse rather than silently continuing another
    // session's count.
    writeShard("s1.json", { sessionId: "other", count: 41, updatedAt: Date.now() });
    expect(trackTurn("s1")).toBe(1);
  });
});

describe("trackTurn store validation", () => {
  // The reproduced blank-bar defect (#92): a four-byte "null" file used to
  // throw out of trackTurn and erase the whole statusline.
  it("rebuilds from a bare null document instead of throwing", () => {
    writeShard("s1.json", "null");
    expect(trackTurn("s1")).toBe(1);
  });

  it("rebuilds when count is not a number", () => {
    writeShard("s1.json", { sessionId: "s1", count: "7", updatedAt: Date.now() });
    expect(trackTurn("s1")).toBe(1);
  });

  it("rebuilds from a torn file", () => {
    writeShard("s1.json", '{"sessionId": "s1", "cou');
    expect(trackTurn("s1")).toBe(1);
  });
});

describe("trackTurn pruning", () => {
  const DAY_MS = 24 * 3600 * 1000;

  it("removes shards untouched for more than 48h on a new session's first render", () => {
    writeShard("ancient.json", {
      sessionId: "ancient",
      count: 99,
      updatedAt: Date.now() - 3 * DAY_MS,
    });
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["fresh.json"]);
  });

  it("keeps shards touched within 48h", () => {
    writeShard("recent.json", {
      sessionId: "recent",
      count: 99,
      updatedAt: Date.now() - 1 * DAY_MS,
    });
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["fresh.json", "recent.json"]);
  });

  it("prunes a shard with no updatedAt, which predates this format", () => {
    writeShard("legacy-format.json", { sessionId: "legacy-format", count: 5 });
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["fresh.json"]);
  });

  it("does not scan the directory again once the session has a shard", () => {
    trackTurn("fresh");
    writeShard("ancient.json", {
      sessionId: "ancient",
      count: 99,
      updatedAt: Date.now() - 3 * DAY_MS,
    });
    // Second render of the same session: its own shard exists, so no sweep.
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["ancient.json", "fresh.json"]);
  });

  it("leaves a shard it cannot parse alone rather than deleting it", () => {
    // A corrupt or unreadable shard is indistinguishable from outside — the
    // sweep must not treat "failed to read" as "safe to delete". Written
    // under a different session's name so the sweep's target survives the
    // current session's own (immediate) rewrite, which would otherwise mask
    // a wrongful delete.
    writeShard("other.json", "null");
    trackTurn("fresh");
    expect(shardFiles()).toContain("other.json");
  });

  it("deletes the pre-shard turn-count.json", () => {
    const legacy = path.join(tmpDir, "gccusage", "turn-count.json");
    fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ sessionId: "old", count: 12 }));
    trackTurn("fresh");
    expect(fs.existsSync(legacy)).toBe(false);
  });
});
