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
const mockFs = vi.hoisted(() => ({ failTempWrite: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const [target, data] = args;
      if (mockFs.failTempWrite && String(target).endsWith(".tmp")) {
        actual.writeFileSync(target, String(data).slice(0, 3));
        const err = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      return actual.writeFileSync(...args);
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
