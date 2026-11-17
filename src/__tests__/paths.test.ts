import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { noPasswd } from "./helpers/no-passwd.js";

vi.mock("node:os", async (importOriginal) =>
  (await import("./helpers/no-passwd.js")).mockOsModule(importOriginal),
);

import {
  getHomeDir,
  findSessionJsonlFiles,
  getCacheDir,
  getConfigDir,
  getClaudeDataDir,
  ensureDir,
  getProjectsDir,
  findTodayJsonlFileStats,
  shardKey,
} from "../utils/paths.js";

let tmpHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-home-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpHome;

  const projectDir = path.join(tmpHome, ".claude", "projects", "-some-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "session-1.jsonl"), "{}\n");
  fs.writeFileSync(path.join(projectDir, "session-2.jsonl"), "{}\n");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("home directory resolution", () => {
  it("uses HOME when it is set", () => {
    expect(getClaudeDataDir()).toBe(path.join(tmpHome, ".claude"));
  });

  it("resolves an absolute data dir when HOME is unset", () => {
    delete process.env["HOME"];
    expect(path.isAbsolute(getClaudeDataDir()!)).toBe(true);
  });

  it("resolves an absolute data dir when HOME is empty", () => {
    process.env["HOME"] = "";
    expect(path.isAbsolute(getClaudeDataDir()!)).toBe(true);
  });

  it("never resolves the data dir under a directory literally named ~", () => {
    delete process.env["HOME"];
    expect(getClaudeDataDir()!.split(path.sep)).not.toContain("~");
  });

  it("resolves an absolute projects dir when HOME is unset", () => {
    delete process.env["HOME"];
    expect(path.isAbsolute(getProjectsDir()!)).toBe(true);
  });

  it("resolves an absolute cache dir when HOME and XDG_CACHE_HOME are unset", () => {
    delete process.env["HOME"];
    delete process.env["XDG_CACHE_HOME"];
    const dir = getCacheDir()!;
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.split(path.sep)).not.toContain("~");
  });

  it("resolves an absolute cache dir when HOME is empty and XDG_CACHE_HOME is unset", () => {
    process.env["HOME"] = "";
    delete process.env["XDG_CACHE_HOME"];
    expect(path.isAbsolute(getCacheDir()!)).toBe(true);
  });

  it("still prefers XDG_CACHE_HOME when it is set", () => {
    process.env["XDG_CACHE_HOME"] = path.join(tmpHome, "xdg");
    expect(getCacheDir()).toBe(path.join(tmpHome, "xdg", "gccusage"));
  });

  // SEC-004. The XDG Base Directory spec: "If an implementation encounters a
  // relative path in any of these variables it should consider the path
  // invalid and ignore it." Honouring it resolved against the cwd.
  it.each([".cache", "~/.cache", "cache/../cache"])(
    "ignores a relative XDG_CACHE_HOME (%j)",
    (relative) => {
      process.env["XDG_CACHE_HOME"] = relative;
      const dir = getCacheDir();
      expect(dir).toBe(path.join(tmpHome, ".cache", "gccusage"));
      expect(dir).not.toBe(path.resolve(relative, "gccusage"));
    },
  );
});

// SEC-004. getConfigDir used `HOME || "~"`: with HOME unset or empty that is
// a relative path, so a repo committing `~/.config/gccusage/settings.json`
// had its config — and its custom-command — loaded from the launch directory.
describe("getConfigDir", () => {
  let originalXdgConfig: string | undefined;

  beforeEach(() => {
    originalXdgConfig = process.env["XDG_CONFIG_HOME"];
    delete process.env["XDG_CONFIG_HOME"];
  });

  afterEach(() => {
    if (originalXdgConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdgConfig;
  });

  it("is under HOME by default", () => {
    expect(getConfigDir()).toBe(path.join(tmpHome, ".config", "gccusage"));
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("is absolute, with no literal ~ segment, when HOME is %s", (_label, home) => {
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;

    const dir = getConfigDir()!;
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.split(path.sep)).not.toContain("~");
  });

  it("prefers an absolute XDG_CONFIG_HOME", () => {
    process.env["XDG_CONFIG_HOME"] = path.join(tmpHome, "xdg");
    expect(getConfigDir()).toBe(path.join(tmpHome, "xdg", "gccusage"));
  });

  it.each([".config", "~/.config", "config/../config"])(
    "ignores a relative XDG_CONFIG_HOME (%j)",
    (relative) => {
      process.env["XDG_CONFIG_HOME"] = relative;
      const dir = getConfigDir();
      expect(dir).toBe(path.join(tmpHome, ".config", "gccusage"));
      expect(dir).not.toBe(path.resolve(relative, "gccusage"));
    },
  );
});

// SEC-004, review of #154. With no usable HOME and no passwd entry,
// getHomeDir() fell back to os.tmpdir() — the shared, world-writable /tmp on
// Linux — so `/tmp/.config/gccusage/settings.json` planted by another user
// loaded and its custom-command ran. Every directory derived from home must
// now be null instead: no config, no cache, no transcripts.
describe("with no home directory at all (SEC-004)", () => {
  let originalTmpdir: string | undefined;
  let originalXdgConfig: string | undefined;
  let sharedTmp: string;

  beforeEach(() => {
    originalTmpdir = process.env["TMPDIR"];
    originalXdgConfig = process.env["XDG_CONFIG_HOME"];
    delete process.env["XDG_CACHE_HOME"];
    delete process.env["XDG_CONFIG_HOME"];
    // A planted config in what os.tmpdir() returns, to prove it is never read.
    sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-shared-tmp-"));
    process.env["TMPDIR"] = sharedTmp;
    noPasswd.on = true;
  });

  afterEach(() => {
    noPasswd.on = false;
    if (originalTmpdir === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = originalTmpdir;
    if (originalXdgConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdgConfig;
    fs.rmSync(sharedTmp, { recursive: true, force: true });
  });

  it.each([
    ["HOME is empty", ""],
    ["HOME is unset", undefined],
  ])("resolves no home, cache, config or transcripts when %s", (_label, home) => {
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;

    expect(getHomeDir()).toBeNull();
    expect(getClaudeDataDir()).toBeNull();
    expect(getProjectsDir()).toBeNull();
    expect(getCacheDir()).toBeNull();
    expect(getConfigDir()).toBeNull();
    expect(findSessionJsonlFiles("session-1")).toEqual([]);
    expect(findTodayJsonlFileStats()).toEqual([]);
  });

  it("does not fall back to a relative TMPDIR either", () => {
    process.env["HOME"] = "";
    process.env["TMPDIR"] = "relative-tmp";

    expect(getHomeDir()).toBeNull();
    expect(getCacheDir()).toBeNull();
    expect(getConfigDir()).toBeNull();
  });

  it("still honours an absolute XDG_CACHE_HOME and XDG_CONFIG_HOME", () => {
    process.env["HOME"] = "";
    process.env["XDG_CACHE_HOME"] = path.join(tmpHome, "xdg-cache");
    process.env["XDG_CONFIG_HOME"] = path.join(tmpHome, "xdg-config");

    expect(getCacheDir()).toBe(path.join(tmpHome, "xdg-cache", "gccusage"));
    expect(getConfigDir()).toBe(path.join(tmpHome, "xdg-config", "gccusage"));
  });
});

// SEC-003. Cache directories came out 0755: anyone on the machine could list
// session ids and read per-session spend. Only directories ensureDir creates
// are narrowed — an existing directory is the user's, and is left as found.
describe("ensureDir", () => {
  const mode = (p: string): number => fs.statSync(p).mode & 0o777;

  it("creates every missing level as 0700", () => {
    const outer = path.join(tmpHome, "cache-root");
    const inner = path.join(outer, "gccusage", "daily");

    ensureDir(inner);

    expect(mode(outer)).toBe(0o700);
    expect(mode(path.join(outer, "gccusage"))).toBe(0o700);
    expect(mode(inner)).toBe(0o700);
  });

  it("does not chmod a directory that already exists", () => {
    const existing = path.join(tmpHome, "users-own");
    fs.mkdirSync(existing);
    fs.chmodSync(existing, 0o755);

    ensureDir(existing);
    ensureDir(path.join(existing, "gccusage"));

    expect(mode(existing)).toBe(0o755);
    expect(mode(path.join(existing, "gccusage"))).toBe(0o700);
  });
});

describe("findSessionJsonlFiles", () => {
  it("returns only the matching session file", () => {
    const files = findSessionJsonlFiles("session-1");
    expect(files).toHaveLength(1);
    expect(path.basename(files[0]!)).toBe("session-1.jsonl");
  });

  it("fails closed when no session id is given", () => {
    expect(findSessionJsonlFiles(undefined)).toHaveLength(0);
    expect(findSessionJsonlFiles("")).toHaveLength(0);
  });
});

describe("findTodayJsonlFileStats", () => {
  beforeEach(() => {
    // Age the files from the outer beforeEach to yesterday so they don't interfere
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const sessionDir = path.join(tmpHome, ".claude", "projects", "-some-project");
    if (fs.existsSync(sessionDir)) {
      for (const file of fs.readdirSync(sessionDir)) {
        const filePath = path.join(sessionDir, file);
        fs.utimesSync(filePath, yesterday, yesterday);
      }
    }
  });

  function writeTranscript(name: string, contents: string): string {
    const dir = path.join(tmpHome, ".claude", "projects", "proj");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("reports the size and mtime of each of today's transcripts", () => {
    const filePath = writeTranscript("a", "line one\nline two\n");
    const stat = fs.statSync(filePath);

    const stats = findTodayJsonlFileStats();

    expect(stats).toHaveLength(1);
    expect(stats[0]!.path).toBe(filePath);
    expect(stats[0]!.size).toBe(stat.size);
    expect(stats[0]!.mtimeMs).toBe(stat.mtimeMs);
  });

  it("excludes transcripts last written before today", () => {
    const filePath = writeTranscript("old", "x\n");
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    fs.utimesSync(filePath, yesterday, yesterday);

    expect(findTodayJsonlFileStats()).toHaveLength(0);
  });
});

describe("shardKey", () => {
  it("passes a Claude Code session UUID through verbatim", () => {
    expect(shardKey("f824ed55-511f-4b26-ba97-20cd7efa5a13")).toBe(
      "f824ed55-511f-4b26-ba97-20cd7efa5a13",
    );
  });

  it("hashes an id containing path separators", () => {
    const key = shardKey("../../etc/passwd");
    expect(key).not.toContain("/");
    expect(key).not.toContain(".");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes an id longer than 128 characters", () => {
    expect(shardKey("a".repeat(129))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for the same input", () => {
    expect(shardKey("../x")).toBe(shardKey("../x"));
  });

  it("separates ids that differ only past the safe-character boundary", () => {
    expect(shardKey("a/b")).not.toBe(shardKey("a/c"));
  });
});
