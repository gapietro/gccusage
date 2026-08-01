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
