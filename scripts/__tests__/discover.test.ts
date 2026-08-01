import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultProjectsDir, discoverSessions, projectLabel } from "../lib/discover.ts";

let root: string;
let originalHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-discover-"));
  originalHome = process.env["HOME"];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("defaultProjectsDir", () => {
  it("uses HOME when it is set", () => {
    process.env["HOME"] = root;
    expect(defaultProjectsDir()).toBe(path.join(root, ".claude", "projects"));
  });

  it("stays absolute when HOME is unset", () => {
    delete process.env["HOME"];
    expect(path.isAbsolute(defaultProjectsDir())).toBe(true);
  });

  it("stays absolute when HOME is empty", () => {
    process.env["HOME"] = "";
    expect(path.isAbsolute(defaultProjectsDir())).toBe(true);
  });
});

function write(relativePath: string, content = "{}\n"): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("projectLabel", () => {
  it("labels the first 26 projects with single letters", () => {
    expect(projectLabel(0)).toBe("proj-a");
    expect(projectLabel(25)).toBe("proj-z");
  });

  it("rolls over to two letters past 26", () => {
    expect(projectLabel(26)).toBe("proj-aa");
    expect(projectLabel(27)).toBe("proj-ab");
  });
});

describe("discoverSessions", () => {
  it("returns an empty list when the directory does not exist", () => {
    expect(discoverSessions(path.join(root, "nope"))).toEqual([]);
  });

  it("finds main session transcripts", () => {
    write("-Users-me-alpha/sess-1.jsonl");
    write("-Users-me-alpha/sess-2.jsonl");

    const found = discoverSessions(root);
    expect(found.map((s) => s.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("assigns stable anonymised labels in sorted directory order", () => {
    write("-Users-me-zebra/sess-1.jsonl");
    write("-Users-me-alpha/sess-2.jsonl");

    const byId = new Map(discoverSessions(root).map((s) => [s.sessionId, s.projectLabel]));
    expect(byId.get("sess-2")).toBe("proj-a"); // alpha sorts first
    expect(byId.get("sess-1")).toBe("proj-b");
  });

  it("attaches subagent transcripts to their parent session", () => {
    write("-Users-me-alpha/sess-1.jsonl");
    write("-Users-me-alpha/sess-1/subagents/agent-aaa.jsonl");
    write("-Users-me-alpha/sess-1/subagents/agent-bbb.jsonl");

    const [session] = discoverSessions(root);
    expect(session!.subagentPaths).toHaveLength(2);
  });

  it("ignores tool-results and memory directories", () => {
    write("-Users-me-alpha/sess-1.jsonl");
    write("-Users-me-alpha/sess-1/tool-results/big.jsonl");
    write("-Users-me-alpha/sess-1/memory/notes.jsonl");

    const [session] = discoverSessions(root);
    expect(session!.subagentPaths).toEqual([]);
  });

  it("emits no filesystem paths in the anonymised label", () => {
    write("-Users-me-secret-client-work/sess-1.jsonl");
    const [session] = discoverSessions(root);
    expect(session!.projectLabel).toBe("proj-a");
    expect(session!.projectLabel).not.toContain("secret");
  });
});
