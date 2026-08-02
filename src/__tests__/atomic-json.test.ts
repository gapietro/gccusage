import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic } from "../utils/atomic-json.js";

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
