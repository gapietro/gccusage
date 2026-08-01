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
