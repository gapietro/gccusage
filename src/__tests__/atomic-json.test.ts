import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import {
  writeJsonAtomic,
  writeFileAtomic,
  readJsonValidated,
  sweepStaleTempFiles,
  STALE_TEMP_FILE_AGE_MS,
} from "../utils/atomic-json.js";

// Off by default, so every fs call in this file passes through to the real
// implementation except inside the one test that flips it. When on, a write
// to a temp file lands a few bytes and then fails — the shape of ENOSPC, or of
// a write interrupted after open(2) created the file. Declared via vi.hoisted
// because a vi.mock factory cannot close over an ordinary top-level variable.
//
// `umask077` stands in for a restrictive umask without changing the real
// one for the whole worker: a `mode` passed at creation is masked with 077,
// as open(2) would under that umask.
//
// `failChmod` stands in for a filesystem that refuses chmod (vfat, some
// network mounts).
//
// `lastTempPath` records the most recent temp-file write, so a test can
// predict the writer's next temp name (same pid, counter + 1).
const mockFs = vi.hoisted(() => ({
  failTempWrite: false,
  umask077: false,
  failChmod: false,
  lastTempPath: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const [target, data, options] = args;
      if (String(target).endsWith(".tmp")) mockFs.lastTempPath = String(target);
      if (mockFs.failTempWrite && String(target).endsWith(".tmp")) {
        actual.writeFileSync(target, String(data).slice(0, 3));
        const err = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      if (mockFs.umask077 && typeof options === "object" && options?.mode !== undefined) {
        return actual.writeFileSync(target, data, { ...options, mode: Number(options.mode) & 0o700 });
      }
      return actual.writeFileSync(...args);
    },
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (mockFs.failChmod) {
        const err = new Error("EPERM: operation not permitted, chmod") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.chmodSync(...args);
    },
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-atomic-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function siblings(dir: string): string[] {
  return fs.readdirSync(dir);
}

describe("writeJsonAtomic", () => {
  it("writes JSON that reads back as the same value", () => {
    const target = path.join(tmpDir, "store.json");
    writeJsonAtomic(target, { a: 1, b: ["x"] });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ a: 1, b: ["x"] });
  });

  it("replaces the whole of a longer existing file", () => {
    const target = path.join(tmpDir, "store.json");
    fs.writeFileSync(target, JSON.stringify({ padding: "x".repeat(500) }));
    writeJsonAtomic(target, { a: 1 });
    expect(fs.readFileSync(target, "utf-8")).toBe(JSON.stringify({ a: 1 }));
  });

  it("creates the parent directory when it does not exist", () => {
    const target = path.join(tmpDir, "nested", "deeper", "store.json");
    writeJsonAtomic(target, { a: 1 });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ a: 1 });
  });

  it("leaves no temporary file behind on success", () => {
    const target = path.join(tmpDir, "store.json");
    writeJsonAtomic(target, { a: 1 });
    expect(siblings(tmpDir)).toEqual(["store.json"]);
  });

  it("removes the temporary file and rethrows when the rename fails", () => {
    // A directory at the target path makes renameSync fail after the temp
    // file has already been written — the one path that can leak a temp file.
    const target = path.join(tmpDir, "store.json");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "occupant"), "keeps the directory non-empty");

    expect(() => writeJsonAtomic(target, { a: 1 })).toThrow();
    expect(siblings(tmpDir)).toEqual(["store.json"]);
  });
});

describe("writeFileAtomic", () => {
  it("writes the exact bytes given, with no JSON encoding", () => {
    const target = path.join(tmpDir, "settings.json");
    const contents = '{\n  "model": "opus"\n}\n';

    writeFileAtomic(target, contents);

    expect(fs.readFileSync(target, "utf-8")).toBe(contents);
  });

  it("creates the parent directory when it does not exist", () => {
    const target = path.join(tmpDir, "nested", "deeper", "settings.json");
    writeFileAtomic(target, "hello");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
  });

  it("leaves no temporary file behind on success", () => {
    const target = path.join(tmpDir, "settings.json");
    writeFileAtomic(target, "hello");
    expect(siblings(tmpDir)).toEqual(["settings.json"]);
  });

  it("removes the temporary file and rethrows when the rename fails", () => {
    // A directory at the target path makes renameSync fail after the temp
    // file has already been written — the one path that can leak a temp file.
    const target = path.join(tmpDir, "settings.json");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "occupant"), "keeps the directory non-empty");

    expect(() => writeFileAtomic(target, "hello")).toThrow();
    expect(siblings(tmpDir)).toEqual(["settings.json"]);
  });

  it("removes the temporary file and rethrows the write error when the write itself fails (REL-008)", () => {
    // The write used to sit outside the try, so a failure after open(2) had
    // created the temp file — ENOSPC, EIO — left it behind, and nothing ever
    // swept it. The rename-failure test above could not catch that: by then
    // the write had succeeded.
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, "previous");

    mockFs.failTempWrite = true;
    try {
      expect(() => writeFileAtomic(target, "hello")).toThrow("ENOSPC");
    } finally {
      mockFs.failTempWrite = false;
    }

    expect(siblings(tmpDir)).toEqual(["settings.json"]);
    expect(fs.readFileSync(target, "utf-8")).toBe("previous");
  });
});

// SEC-003. The temp file was created with the umask default (0644 under the
// usual 022), and renaming it over the target replaced the target's mode.
describe("file modes (SEC-003)", () => {
  const mode = (p: string): number => fs.statSync(p).mode & 0o777;

  it("writeFileAtomic applies an explicit mode to the file it creates", () => {
    const target = path.join(tmpDir, "settings.json");
    writeFileAtomic(target, "{}", 0o600);
    expect(mode(target)).toBe(0o600);
  });

  it("writeFileAtomic applies the mode exactly, replacing a wider existing file", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o644);

    writeFileAtomic(target, "new", 0o600);

    expect(mode(target)).toBe(0o600);
  });

  it("writeFileAtomic applies the mode exactly under a restrictive umask", () => {
    // Creation alone is umask-masked: setup preserving a user's 0640 would
    // land 0600 under umask 077. The explicit chmod is what makes it exact.
    const target = path.join(tmpDir, "settings.json");
    mockFs.umask077 = true;
    try {
      writeFileAtomic(target, "{}", 0o640);
    } finally {
      mockFs.umask077 = false;
    }
    expect(mode(target)).toBe(0o640);
  });

  it("still writes, no wider than asked, on a filesystem that refuses chmod", () => {
    // Every cache write passes a mode, and the render-path daily-shard write
    // is not yet caught (REL-005): a chmod failure that failed the write
    // would erase the bar on every render on such a filesystem.
    const target = path.join(tmpDir, "pricing.json");
    mockFs.failChmod = true;
    try {
      expect(() => writeJsonAtomic(target, { a: 1 })).not.toThrow();
    } finally {
      mockFs.failChmod = false;
    }
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ a: 1 });
    expect(mode(target) & ~0o600).toBe(0);
  });

  it("writeJsonAtomic writes cache files as 0600", () => {
    const target = path.join(tmpDir, "pricing.json");
    writeJsonAtomic(target, { a: 1 });
    expect(mode(target)).toBe(0o600);
  });
});

// SEC-003, review of #154. The temp name `<target>.<pid>.<n>.tmp` is
// predictable, and the temp file was opened with flag "w": a symlink planted
// at that name was followed, so the write (and the chmod after it) landed on
// whatever the link pointed at, and a leftover regular file kept its own
// mode. The temp file must always be one this write created.
describe("the temp file is always freshly created (SEC-003)", () => {
  const mode = (p: string): number => fs.statSync(p).mode & 0o777;

  /** The temp path the next writeFileAtomic call in this process will use. */
  function nextTempPath(target: string): string {
    writeFileAtomic(path.join(tmpDir, "probe.json"), "{}");
    const match = /\.(\d+)\.(\d+)\.tmp$/.exec(mockFs.lastTempPath);
    expect(match, "the probe write recorded its temp name").not.toBeNull();
    return `${target}.${match![1]}.${Number(match![2]) + 1}.tmp`;
  }

  it("does not follow a symlink planted at the temp name", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-victim-"));
    try {
      const victim = path.join(outside, "victim.txt");
      fs.writeFileSync(victim, "untouched");
      fs.chmodSync(victim, 0o644);
      const target = path.join(tmpDir, "settings.json");
      fs.symlinkSync(victim, nextTempPath(target));

      writeFileAtomic(target, "new contents", 0o600);

      expect(fs.readFileSync(victim, "utf-8")).toBe("untouched");
      expect(mode(victim)).toBe(0o644);
      expect(fs.readFileSync(target, "utf-8")).toBe("new contents");
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(mode(target)).toBe(0o600);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not inherit a stale leftover's wide mode, even where chmod is refused", () => {
    // With "w" the leftover is reused and keeps 0644; on a filesystem that
    // refuses chmod nothing narrows it. Only a fresh create gives 0600.
    const target = path.join(tmpDir, "pricing.json");
    const leftover = nextTempPath(target);
    fs.writeFileSync(leftover, "stale");
    fs.chmodSync(leftover, 0o644);

    mockFs.failChmod = true;
    try {
      writeJsonAtomic(target, { a: 1 });
    } finally {
      mockFs.failChmod = false;
    }

    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ a: 1 });
    expect(mode(target)).toBe(0o600);
    expect(siblings(tmpDir).sort()).toEqual(["pricing.json", "probe.json"]);
  });
});

describe("sweepStaleTempFiles (REL-008)", () => {
  const HOUR = 60 * 60 * 1000;

  function touch(file: string, ageMs: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }

  it("removes an orphaned temp file older than the threshold, at the root and one level down", () => {
    // Orphans land beside their target, and targets live in daily/ and
    // blocks/ as well as at the root.
    touch(path.join(tmpDir, "statusline-cache.json.63525.1.tmp"), 2 * HOUR);
    touch(path.join(tmpDir, "daily", "abc.json.411.0.tmp"), 2 * HOUR);
    touch(path.join(tmpDir, "blocks", "current.json.9.12.tmp"), 2 * HOUR);

    sweepStaleTempFiles(tmpDir);

    expect(siblings(tmpDir).sort()).toEqual(["blocks", "daily"]);
    expect(siblings(path.join(tmpDir, "daily"))).toEqual([]);
    expect(siblings(path.join(tmpDir, "blocks"))).toEqual([]);
  });

  it("keeps a temp file younger than the threshold — it may be another process's write in flight", () => {
    touch(path.join(tmpDir, "pricing.json.700.3.tmp"), STALE_TEMP_FILE_AGE_MS / 2);

    sweepStaleTempFiles(tmpDir);

    expect(siblings(tmpDir)).toEqual(["pricing.json.700.3.tmp"]);
  });

  it("leaves old files that are not this writer's temp files alone", () => {
    touch(path.join(tmpDir, "pricing.json"), 48 * HOUR);
    touch(path.join(tmpDir, "notes.tmp"), 48 * HOUR);
    touch(path.join(tmpDir, "export.1.tmp"), 48 * HOUR);

    sweepStaleTempFiles(tmpDir);

    expect(siblings(tmpDir).sort()).toEqual(["export.1.tmp", "notes.tmp", "pricing.json"]);
  });

  it("matches what writeFileAtomic actually names its temp files", () => {
    // Ties the sweep's pattern to the writer, so renaming the temp scheme
    // cannot silently turn the sweep into a no-op. The leak is manufactured
    // through the real writer (failing its write, with the cleanup unlink
    // stubbed out — standing in for a SIGKILL between the two), then aged.
    const target = path.join(tmpDir, "store.json");
    mockFs.failTempWrite = true;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    try {
      expect(() => writeFileAtomic(target, "hello")).toThrow();
    } finally {
      mockFs.failTempWrite = false;
      unlinkSpy.mockRestore();
    }
    const [leaked] = siblings(tmpDir);
    expect(leaked).toMatch(/\.tmp$/);
    const when = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(path.join(tmpDir, leaked!), when, when);

    sweepStaleTempFiles(tmpDir);

    expect(siblings(tmpDir)).toEqual([]);
  });

  it("does not follow a symlinked directory out of the cache", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-outside-"));
    try {
      touch(path.join(outside, "keep.json.1.1.tmp"), 2 * HOUR);
      fs.symlinkSync(outside, path.join(tmpDir, "linked"));

      sweepStaleTempFiles(tmpDir);

      expect(siblings(outside)).toEqual(["keep.json.1.1.tmp"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never throws for a missing directory", () => {
    expect(() => sweepStaleTempFiles(path.join(tmpDir, "absent"))).not.toThrow();
  });
});

describe("readJsonValidated", () => {
  const Schema = v.object({ name: v.string(), count: v.number() });

  it("returns the parsed value when the file matches the schema", () => {
    const target = path.join(tmpDir, "ok.json");
    fs.writeFileSync(target, JSON.stringify({ name: "a", count: 2 }));
    expect(readJsonValidated(target, Schema)).toEqual({ name: "a", count: 2 });
  });

  it("returns null when the file does not exist", () => {
    expect(readJsonValidated(path.join(tmpDir, "absent.json"), Schema)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const target = path.join(tmpDir, "torn.json");
    fs.writeFileSync(target, '{"name": "a", "cou');
    expect(readJsonValidated(target, Schema)).toBeNull();
  });

  // The exact shape that blanked the statusline: JSON.parse("null") succeeds
  // and yields null, which every `as T` cast in the codebase then dereferenced.
  it("returns null for a bare null document", () => {
    const target = path.join(tmpDir, "null.json");
    fs.writeFileSync(target, "null");
    expect(readJsonValidated(target, Schema)).toBeNull();
  });

  it("returns null when a field has the wrong type", () => {
    const target = path.join(tmpDir, "wrong.json");
    fs.writeFileSync(target, JSON.stringify({ name: "a", count: "2" }));
    expect(readJsonValidated(target, Schema)).toBeNull();
  });

  // valibot's object schema accepts an array and yields {}, so an array root
  // only fails because required keys are missing. Pin that it does fail.
  it("returns null for an array root", () => {
    const target = path.join(tmpDir, "array.json");
    fs.writeFileSync(target, "[1,2,3]");
    expect(readJsonValidated(target, Schema)).toBeNull();
  });
});
