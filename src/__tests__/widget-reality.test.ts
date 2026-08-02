import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getWidgetTypes, getWidget } from "../widgets/registry.js";
import { WIDGET_EXPECTATIONS } from "./fixtures/widget-expectations.js";
import { contextFromFixture } from "./fixtures/context-from-fixture.js";
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
    execFileSync("git", args, {
      cwd: repoDir,
      stdio: "pipe",
      // Neutralize ambient system/XDG git config (commit.gpgsign, core.hooksPath,
      // init.templateDir, etc.) so this scratch repo's behaviour is deterministic
      // regardless of the host machine's global git setup. HOME is already
      // overridden by the caller, which handles ~/.gitconfig, but not these.
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
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

beforeAll(() => {
  originalHome = process.env["HOME"];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-reality-"));
  process.env["HOME"] = tmpHome;
  const fx = midFixture as unknown as RealPayloadFixture;
  const cwd = (fx.stdin as { cwd: string }).cwd.split(fx.homePlaceholder).join(tmpHome);
  initScratchRepo(cwd);
  // Secondary fixtures substitute their own `cwd`, which may point at a
  // subdirectory that was never created (e.g. opus5-1m-early's ".../src/widgets").
  // git.ts swallows ENOENT and returns null, which would make git-branch/git-changes
  // false-pass the "renders every widget without throwing" check for exactly the
  // widgets most likely to throw. Ensure every secondary fixture's cwd exists,
  // nested inside the same scratch repo so git commands still resolve.
  for (const raw of [fableFixture, earlyFixture]) {
    const sfx = raw as unknown as RealPayloadFixture;
    const sCwd = (sfx.stdin as { cwd: string }).cwd.split(sfx.homePlaceholder).join(tmpHome);
    fs.mkdirSync(sCwd, { recursive: true });
  }
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

// #60 was two widgets — cache-hit-rate and tokens-cached — both defaulting to
// the label "Cache:" for two different quantities, which made them
// indistinguishable when placed side by side. Nothing structural stopped a
// third widget from doing the same, so this guards the property rather than
// the instance: no two widgets may lead with the same `Word:` label.
//
// The labels are read back out of RENDERED text, not from the widget sources,
// because each default lives inline as `config.label ?? "..."` and is not
// exported. That has two consequences worth stating: widgets that decline on
// this payload (custom-text, custom-command, vim-mode) are not covered, and a
// label is only seen if it survives into the output.
//
// The pattern requires the label to be alphabetic, which is what keeps
// per-model out: it renders "Opus 5:$22.52", where the text before the colon
// is data, not a label.
const LABEL_PATTERN = /^([A-Za-z][A-Za-z ]*):/;

// Duplicate labels that are accepted, each with the reason. An entry here is a
// deliberate exemption, not a way to silence the guard: adding one should
// require the same argument this one makes.
const ALLOWED_LABEL_COLLISIONS: Record<string, { types: string[]; why: string }> = {
  In: {
    types: ["tokens-input", "token-breakdown"],
    why: "token-breakdown is the compound form ('In:396 Out:137.8k') of the two single-metric widgets, so it reuses their labels by design. Nobody configures the compound alongside its own parts.",
  },
};

it("gives no two widgets the same label (#60)", () => {
  const ctx = contextFromFixture(midFixture as unknown as RealPayloadFixture, tmpHome);
  const byLabel = new Map<string, string[]>();

  for (const type of Object.keys(WIDGET_EXPECTATIONS)) {
    const text = getWidget(type)!.render(ctx, { type } as never)?.text;
    const label = text?.match(LABEL_PATTERN)?.[1];
    if (label === undefined) continue;
    byLabel.set(label, [...(byLabel.get(label) ?? []), type]);
  }

  // Non-vacuity: if the extraction ever stops finding labels, this test would
  // pass while checking nothing at all.
  expect(byLabel.size, "no labels extracted — the guard would be vacuous").toBeGreaterThan(5);

  const collisions = [...byLabel.entries()]
    .filter(([, types]) => types.length > 1)
    .filter(([label, types]) => {
      const allowed = ALLOWED_LABEL_COLLISIONS[label];
      return !allowed || [...types].sort().join() !== [...allowed.types].sort().join();
    })
    .map(([label, types]) => `${label}: ${types.join(" + ")}`);

  expect(collisions, `widgets sharing a label: ${collisions.join("; ")}`).toEqual([]);
});

// Widgets expected to render `null` for structural reasons (no user-supplied
// text/command, or a feature that is off). Derived from the expectation table
// itself, rather than hardcoded, so a fourth legitimately-declining widget
// can't silently go uncovered by this list.
const STRUCTURAL_NULLS = Object.entries(WIDGET_EXPECTATIONS)
  .filter(([, expectation]) => expectation.text === null && expectation.knownWrong === undefined)
  .map(([type]) => type);

const primaryDerivedAt = (midFixture as unknown as RealPayloadFixture).derivedAt;

describe.each([
  ["fable5-1m-low", fableFixture],
  ["opus5-1m-early", earlyFixture],
])("secondary fixture %s", (name, raw) => {
  const fx = raw as unknown as RealPayloadFixture;

  beforeAll(() => {
    vi.setSystemTime(fx.derivedAt);
  });

  afterAll(() => {
    // Restore the primary fixture's clock so later files/state relying on
    // the primary matrix's fake-time assumptions are unaffected.
    vi.setSystemTime(primaryDerivedAt);
  });

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

// The primary matrix above can't catch project.ts regressing to stdin.cwd
// (#59): opus5-1m-mid has cwd === project_dir, so "demo-project" comes out
// either way. opus5-1m-early is the only fixture where they diverge — its
// cwd is a subdirectory of the repo root — so it's the only payload that can
// actually distinguish "read project_dir" from "read cwd". Asserting on
// cwd's own text too is what makes this non-vacuous: it proves the two
// widgets genuinely disagree on this payload, rather than both happening to
// render the same string. Neither widget is time-dependent, but this reads
// after the describe.each block above, which leaves opus5-1m-early's clock
// active for its own tests and restores the primary clock in its afterAll —
// so system time here is back to the primary fixture regardless.
it("renders the repo root, not the session's subdirectory cwd (#59)", () => {
  const ctx = contextFromFixture(earlyFixture as unknown as RealPayloadFixture, tmpHome);
  expect(getWidget("project")!.render(ctx, { type: "project" } as never)!.text).toBe("demo-project");
  expect(getWidget("cwd")!.render(ctx, { type: "cwd" } as never)!.text).toBe("~/projects/demo-project/src/widgets");
});
