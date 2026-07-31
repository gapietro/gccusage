import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildReport, renderMarkdown } from "../lib/report.ts";
import { nodeRunsTypeScript } from "./node-ts-support.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-report-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a transcript with `turns` assistant turns and one Bash tool result. */
function seedSession(projectDir: string, sessionId: string, turns: number, subagents = 0): void {
  const dir = path.join(root, projectDir);
  fs.mkdirSync(dir, { recursive: true });

  const records: unknown[] = [];
  for (let i = 0; i < turns; i += 1) {
    records.push({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 2_000,
        },
        content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash" }],
      },
    });
    records.push({
      type: "user",
      toolUseResult: { stdout: "x".repeat(500) },
      message: { content: [{ type: "tool_result", tool_use_id: `toolu_${i}` }] },
    });
  }
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );

  if (subagents > 0) {
    const subDir = path.join(dir, sessionId, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    for (let i = 0; i < subagents; i += 1) {
      fs.writeFileSync(path.join(subDir, `agent-${i}.jsonl`), "{}\n");
    }
  }
}

describe("buildReport", () => {
  it("counts the corpus it analysed", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    seedSession("-Users-me-beta", "sess-2", 10, 3);

    const report = buildReport(root);
    expect(report.corpus.mainSessions).toBe(2);
    expect(report.corpus.analysedSessions).toBe(2);
    expect(report.corpus.subagentTranscripts).toBe(3);
    expect(report.corpus.projects).toBe(2);
  });

  it("excludes sessions below the turn threshold from analysis", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    seedSession("-Users-me-alpha", "sess-short", 2);

    const report = buildReport(root);
    expect(report.corpus.mainSessions).toBe(2);
    expect(report.corpus.analysedSessions).toBe(1);
  });

  it("profiles tool result sizes", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    const report = buildReport(root);
    expect(report.tools[0]!.tool).toBe("Bash");
    expect(report.tools[0]!.calls).toBe(10);
  });

  it("scores every candidate signal", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    seedSession("-Users-me-beta", "sess-2", 20);
    const report = buildReport(root);
    expect(report.signals.length).toBeGreaterThanOrEqual(6);
  });

  it("emits no real project directory names anywhere in the report", () => {
    seedSession("-Users-me-confidential-client", "sess-1", 10);
    const serialized = JSON.stringify(buildReport(root));
    expect(serialized).not.toContain("confidential");
    expect(serialized).not.toContain(root);
  });
});

describe("renderMarkdown", () => {
  it("renders headed sections a document can quote", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);
    const md = renderMarkdown(buildReport(root));
    expect(md).toContain("## Corpus");
    expect(md).toContain("## Cost decomposition");
    expect(md).toContain("## Tool result sizes");
    expect(md).toContain("## Candidate signals");
  });

  it("leaks no directory names into the markdown", () => {
    seedSession("-Users-me-confidential-client", "sess-1", 10);
    const md = renderMarkdown(buildReport(root));
    expect(md).not.toContain("confidential");
  });
});

// Spawns the real entry point, so it needs a Node that runs .ts directly.
describe.skipIf(!nodeRunsTypeScript)("CLI", () => {
  it("prints markdown by default and JSON with --json", () => {
    seedSession("-Users-me-alpha", "sess-1", 10);

    const md = execFileSync(
      process.execPath,
      ["scripts/analyze-transcripts.ts", "--projects-dir", root],
      { encoding: "utf8" },
    );
    expect(md).toContain("## Corpus");

    const json = execFileSync(
      process.execPath,
      ["scripts/analyze-transcripts.ts", "--projects-dir", root, "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(json).corpus.mainSessions).toBe(1);
  });
});
