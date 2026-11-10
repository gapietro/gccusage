import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { StatusJsonSchema } from "../types/status-json.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

// opus5-1m-early is the fixture whose session was started in a subdirectory.
// It is the whole evidence base for #59, so assert against it rather than a
// hand-written payload: a hand-written one encodes what we believe Claude
// Code sends, which is exactly the failure mode #47 exists to close.
describe("StatusJsonSchema workspace", () => {
  const fx = earlyFixture as unknown as RealPayloadFixture;

  it("keeps workspace.project_dir instead of stripping it", () => {
    const parsed = v.parse(StatusJsonSchema, fx.stdin);
    expect(parsed.workspace?.project_dir).toBe(`${fx.homePlaceholder}/projects/demo-project`);
  });

  it("pins #59: cwd is a subdirectory of project_dir in this payload", () => {
    const parsed = v.parse(StatusJsonSchema, fx.stdin);
    const projectDir = parsed.workspace?.project_dir;
    expect(projectDir).toBe(`${fx.homePlaceholder}/projects/demo-project`);
    expect(parsed.cwd).toBe(`${projectDir}/src/widgets`);
  });

  it("still accepts a payload with no workspace at all", () => {
    const parsed = v.parse(StatusJsonSchema, { cwd: "/tmp/x" });
    expect(parsed.workspace).toBeUndefined();
  });
});

describe("StatusJsonSchema effort (#139)", () => {
  // Claude Code 2.1.322 sends `...Hw(model) && { effort: { level } }` — the
  // block is absent entirely for models without effort support.
  it("keeps effort.level instead of stripping it", () => {
    const parsed = v.parse(StatusJsonSchema, { effort: { level: "max" } });
    expect(parsed.effort?.level).toBe("max");
  });

  it("accepts a level outside today's set rather than dropping it", () => {
    // The level set already differs per model; a future level must render.
    const parsed = v.parse(StatusJsonSchema, { effort: { level: "ultra" } });
    expect(parsed.effort?.level).toBe("ultra");
  });

  it("leaves effort undefined when the payload has none", () => {
    const parsed = v.parse(StatusJsonSchema, { model: { id: "claude-sonnet-4-5" } });
    expect(parsed.effort).toBeUndefined();
  });

  it.each([
    ["a number", 3],
    ["null", null],
    ["a string", "high"],
    ["an array", ["high"]],
  ])("costs only effort when effort is %s (#83 posture)", (_name, effort) => {
    const parsed = v.parse(StatusJsonSchema, {
      effort,
      model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
      cost: { total_cost_usd: 1.23 },
    });
    expect(parsed.effort?.level).toBeUndefined();
    expect(parsed.model).toEqual({ id: "claude-opus-5-5", display_name: "Opus 5.5" });
    expect(parsed.cost?.total_cost_usd).toBe(1.23);
  });

  it("costs only the level when level has the wrong type", () => {
    const parsed = v.parse(StatusJsonSchema, { effort: { level: 7 }, cwd: "/tmp/x" });
    // The block itself must survive; without this the test cannot tell a
    // lenient level from a lenient-only-at-the-block schema.
    expect(parsed.effort).toBeDefined();
    expect(parsed.effort?.level).toBeUndefined();
    expect(parsed.cwd).toBe("/tmp/x");
  });
});
