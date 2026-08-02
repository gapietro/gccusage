import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import { writeJsonAtomic, writeFileAtomic, readJsonValidated } from "../utils/atomic-json.js";

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
