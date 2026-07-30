import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSessionJsonlFiles } from "../utils/paths.js";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-home-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;

  const projectDir = path.join(tmpHome, ".claude", "projects", "-some-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "session-1.jsonl"), "{}\n");
  fs.writeFileSync(path.join(projectDir, "session-2.jsonl"), "{}\n");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
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
