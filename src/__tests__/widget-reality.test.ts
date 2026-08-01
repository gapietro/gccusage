import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as v from "valibot";
import { getWidgetTypes, getWidget } from "../widgets/registry.js";
import { WIDGET_EXPECTATIONS } from "./fixtures/widget-expectations.js";
import { StatusJsonSchema } from "../types/status-json.js";
import type { RenderContext } from "../types/render-context.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };
import fableFixture from "./fixtures/real-payloads/fable5-1m-low.json" with { type: "json" };
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

describe("expectation table completeness", () => {
  it("covers every registered widget type", () => {
    const missing = getWidgetTypes().filter((t) => !(t in WIDGET_EXPECTATIONS));
    expect(missing, `registered widgets with no expectation entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no entry for an unregistered widget type", () => {
    const registered = new Set(getWidgetTypes());
    const stale = Object.keys(WIDGET_EXPECTATIONS).filter((t) => !registered.has(t));
    expect(stale, `expectation entries with no registered widget: ${stale.join(", ")}`).toEqual([]);
  });
});

let tmpHome: string;
let originalHome: string | undefined;

function initScratchRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "reality-fixture");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  git("add", "seed.txt");
  git("commit", "-q", "-m", "seed");
  // one ADDED file -> git-changes renders "+1"
  fs.writeFileSync(path.join(repoDir, "added.txt"), "added\n");
  git("add", "added.txt");
}

/** Rebuild a RenderContext from a fixture's recorded derived values. */
function contextFromFixture(fx: RealPayloadFixture, homeDir: string): RenderContext {
  const stdinRaw = JSON.parse(
    JSON.stringify(fx.stdin).split(fx.homePlaceholder).join(homeDir),
  );
  return {
    stdin: v.parse(StatusJsonSchema, stdinRaw),
    metrics: {
      ...fx.derived.metrics,
      byModel: new Map(fx.derived.metrics.byModel as unknown as [string, unknown][]),
    } as RenderContext["metrics"],
    block: fx.derived.block,
    burnRate: fx.derived.burnRate,
    pricing: {},
    sessionCostUsd: fx.derived.sessionCostUsd,
    todayCostUsd: fx.derived.todayCostUsd,
    costByModel: new Map(fx.derived.costByModel),
    sessionStartTime: fx.derived.sessionStartTime,
    terminalWidth: 200,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: fx.controlled.turnCount,
  };
}

beforeAll(() => {
  originalHome = process.env["HOME"];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-reality-"));
  process.env["HOME"] = tmpHome;
  const fx = midFixture as unknown as RealPayloadFixture;
  const cwd = (fx.stdin as { cwd: string }).cwd.split(fx.homePlaceholder).join(tmpHome);
  initScratchRepo(cwd);
  vi.useFakeTimers();
  vi.setSystemTime(fx.derivedAt);
});

afterAll(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("widget matrix against a real payload", () => {
  const fx = midFixture as unknown as RealPayloadFixture;

  for (const [type, expected] of Object.entries(WIDGET_EXPECTATIONS)) {
    it(`${type} renders exactly as recorded${expected.knownWrong ? ` (known wrong: #${expected.knownWrong})` : ""}`, () => {
      const ctx = contextFromFixture(fx, tmpHome);
      const out = getWidget(type)!.render(ctx, { type } as never);
      if (expected.text === null) {
        expect(out, `${type}: ${expected.why}`).toBeNull();
      } else {
        expect(out, `${type} returned null but should render`).not.toBeNull();
        expect(out!.text, `${type}: ${expected.why}`).toBe(expected.text);
      }
    });
  }
});

const STRUCTURAL_NULLS = ["custom-text", "custom-command", "vim-mode"];

describe.each([
  ["fable5-1m-low", fableFixture],
  ["opus5-1m-early", earlyFixture],
])("secondary fixture %s", (name, raw) => {
  const fx = raw as unknown as RealPayloadFixture;

  it("renders every widget without throwing", () => {
    const ctx = contextFromFixture(fx, tmpHome);
    for (const type of Object.keys(WIDGET_EXPECTATIONS)) {
      expect(
        () => getWidget(type)!.render(ctx, { type } as never),
        `${type} threw against ${name}`,
      ).not.toThrow();
    }
  });

  it("keeps structurally-null widgets null", () => {
    const ctx = contextFromFixture(fx, tmpHome);
    for (const type of STRUCTURAL_NULLS) {
      expect(getWidget(type)!.render(ctx, { type } as never), type).toBeNull();
    }
  });
});
