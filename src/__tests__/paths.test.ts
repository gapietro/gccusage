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
  narrowCacheModes,
  collapseHome,
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

// SEC-003, review of #154. ensureDir only narrows what it creates, so an
// install from before that fix kept a 0755 cache dir and 0644 shards that are
// never rewritten. narrowCacheModes strips group/other bits from OUR tree:
// the cache dir, its direct subdirectories, and the files at those two levels.
describe("narrowCacheModes", () => {
  const mode = (p: string): number => fs.lstatSync(p).mode & 0o777;
  let cache: string;

  beforeEach(() => {
    cache = path.join(tmpHome, "cache", "gccusage");
    fs.mkdirSync(path.join(cache, "daily", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(cache, "pricing.json"), "{}");
    fs.writeFileSync(path.join(cache, "daily", "s1.json"), "{}");
    fs.writeFileSync(path.join(cache, "daily", "deeper", "x.json"), "{}");
    for (const d of [cache, path.join(cache, "daily"), path.join(cache, "daily", "deeper")]) {
      fs.chmodSync(d, 0o755);
    }
    for (const f of ["pricing.json", "daily/s1.json", "daily/deeper/x.json"]) {
      fs.chmodSync(path.join(cache, f), 0o644);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("narrows the cache dir, its subdirectories and the files at both levels", () => {
    narrowCacheModes(cache);

    expect(mode(cache)).toBe(0o700);
    expect(mode(path.join(cache, "daily"))).toBe(0o700);
    expect(mode(path.join(cache, "pricing.json"))).toBe(0o600);
    expect(mode(path.join(cache, "daily", "s1.json"))).toBe(0o600);
  });

  it("goes no deeper than one level of subdirectories", () => {
    narrowCacheModes(cache);

    expect(mode(path.join(cache, "daily", "deeper"))).toBe(0o755);
    expect(mode(path.join(cache, "daily", "deeper", "x.json"))).toBe(0o644);
  });

  it("only removes bits, never adds them", () => {
    fs.chmodSync(path.join(cache, "pricing.json"), 0o400);
    narrowCacheModes(cache);
    expect(mode(path.join(cache, "pricing.json"))).toBe(0o400);
  });

  it("does not follow a symlinked subdirectory or file out of the cache", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-outside-"));
    try {
      fs.chmodSync(outside, 0o755);
      const victim = path.join(outside, "victim.json");
      fs.writeFileSync(victim, "{}");
      fs.chmodSync(victim, 0o644);
      fs.symlinkSync(outside, path.join(cache, "linked-dir"));
      fs.symlinkSync(victim, path.join(cache, "linked-file.json"));

      narrowCacheModes(cache);

      expect(mode(outside)).toBe(0o755);
      expect(mode(victim)).toBe(0o644);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves entries owned by another uid alone", () => {
    // `getuid` is optional on the type (absent on Windows).
    const proc = process as { getuid: () => number };
    vi.spyOn(proc, "getuid").mockReturnValue(proc.getuid() + 1);

    narrowCacheModes(cache);

    expect(mode(cache)).toBe(0o755);
    expect(mode(path.join(cache, "pricing.json"))).toBe(0o644);
  });

  it("never throws for a missing directory", () => {
    expect(() => narrowCacheModes(path.join(tmpHome, "absent"))).not.toThrow();
  });
});

// Review of #154: a relative XDG value is ignored per the spec (SEC-004), which
// silently moves the cache or config somewhere the user did not say. Under
// GCCUSAGE_DEBUG that is reported — once per value, since getCacheDir runs
// many times per render.
describe("ignored relative XDG values under GCCUSAGE_DEBUG", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports an ignored XDG_CACHE_HOME once, naming the variable and value", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GCCUSAGE_DEBUG", "1");
    vi.stubEnv("XDG_CACHE_HOME", "relative-cache-once");

    getCacheDir();
    getCacheDir();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain("XDG_CACHE_HOME");
    expect(logged).toContain("relative-cache-once");
  });

  it("reports an ignored XDG_CONFIG_HOME too", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GCCUSAGE_DEBUG", "1");
    vi.stubEnv("XDG_CONFIG_HOME", "relative-config");

    getConfigDir();

    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("XDG_CONFIG_HOME");
  });

  it("stays silent without GCCUSAGE_DEBUG", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GCCUSAGE_DEBUG", "");
    vi.stubEnv("XDG_CACHE_HOME", "relative-cache-silent");

    getCacheDir();

    expect(errSpy).not.toHaveBeenCalled();
  });
});

// Review of #154: one owner for "collapse home to ~", shared by the config
// error line and the cwd widget, matching on a segment boundary only.
describe("collapseHome", () => {
  afterEach(() => {
    noPasswd.on = false;
  });

  it("collapses home itself and paths under it", () => {
    expect(collapseHome(tmpHome)).toBe("~");
    expect(collapseHome(path.join(tmpHome, "a", "b"))).toBe(path.join("~", "a", "b"));
  });

  it("leaves a sibling that merely shares home's prefix alone", () => {
    expect(collapseHome(`${tmpHome}2${path.sep}x`)).toBe(`${tmpHome}2${path.sep}x`);
  });

  it("collapses nothing when HOME is /", () => {
    process.env["HOME"] = "/";
    expect(collapseHome("/etc/hosts")).toBe("/etc/hosts");
  });

  it("collapses nothing when there is no home at all", () => {
    process.env["HOME"] = "";
    noPasswd.on = true;
    expect(collapseHome(path.join(tmpHome, "a"))).toBe(path.join(tmpHome, "a"));
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
