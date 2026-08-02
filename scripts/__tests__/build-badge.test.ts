import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BADGE_END,
  BADGE_START,
  PENDING,
  formatBuild,
  nextBuild,
  renderBadges,
  shieldsEscape,
  todayInZone,
} from "../lib/build-badge.ts";
import { nodeRunsTypeScript } from "./node-ts-support.ts";

const readme = (badges: string): string =>
  ["# gccusage", "", BADGE_START, badges, BADGE_END, "", "A statusline.", ""].join("\n");

describe("todayInZone", () => {
  it("reports the New York date, not the UTC one, after 8pm local", () => {
    // 2026-08-02T01:30:00Z is still 2026-08-01 21:30 in New York.
    const now = new Date("2026-08-02T01:30:00Z");
    expect(todayInZone(now, "America/New_York")).toBe("2026-08-01");
    expect(todayInZone(now, "UTC")).toBe("2026-08-02");
  });

  it("pads single-digit months and days", () => {
    expect(todayInZone(new Date("2026-01-05T17:00:00Z"), "America/New_York")).toBe("2026-01-05");
  });
});

describe("nextBuild", () => {
  it("increments the count on a push made the same day", () => {
    expect(nextBuild({ date: "2026-08-01", count: 3, build: "0801.3" }, "2026-08-01")).toEqual({
      date: "2026-08-01",
      count: 4,
      build: "0801.4",
    });
  });

  it("resets to 1 on the first push of a new day", () => {
    expect(nextBuild({ date: "2026-08-01", count: 9, build: "0801.9" }, "2026-08-02")).toEqual({
      date: "2026-08-02",
      count: 1,
      build: "0802.1",
    });
  });

  it("treats missing, malformed, and partial state as a fresh day", () => {
    for (const state of [
      undefined,
      null,
      "not an object",
      {},
      { date: "2026-08-01" },
      { count: 3 },
      { date: "2026-08-01", count: "3" },
      { date: 20260801, count: 3 },
      { date: "2026-08-01", count: Number.NaN },
      { date: "2026-08-01", count: -2 },
      { date: "2026-08-01", count: 1.5 },
      { date: "", count: 0, build: "" },
    ]) {
      expect(nextBuild(state, "2026-08-01")).toEqual({
        date: "2026-08-01",
        count: 1,
        build: "0801.1",
      });
    }
  });

  it("keeps build consistent with its own date and count", () => {
    const state = nextBuild({ date: "2026-12-25", count: 11, build: "wrong" }, "2026-12-25");
    expect(state.build).toBe(formatBuild(state.date, state.count));
    expect(state.build).toBe("1225.12");
  });
});

describe("formatBuild", () => {
  it("drops the year and keeps MMDD zero-padded", () => {
    expect(formatBuild("2026-01-05", 7)).toBe("0105.7");
    expect(formatBuild("2026-11-30", 1)).toBe("1130.1");
  });
});

describe("shieldsEscape", () => {
  it("doubles dashes and underscores so shields renders them literally", () => {
    expect(shieldsEscape("1.0.0-rc1")).toBe("1.0.0--rc1");
    expect(shieldsEscape("0.2.0")).toBe("0.2.0");
    expect(shieldsEscape("a_b")).toBe("a__b");
    expect(shieldsEscape("two words")).toBe("two_words");
  });
});

describe("renderBadges", () => {
  it("writes both badges between the markers", () => {
    const result = renderBadges(readme("![build](old)"), { version: "0.2.0", build: "0801.3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readme).toContain("https://img.shields.io/badge/version-0.2.0-blue");
    expect(result.readme).toContain("https://img.shields.io/badge/build-0801.3-brightgreen");
    expect(result.readme).not.toContain("![build](old)");
  });

  it("is idempotent — a second run with the same values changes nothing", () => {
    const once = renderBadges(readme(PENDING), { version: "0.2.0", build: "0801.3" });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = renderBadges(once.readme, { version: "0.2.0", build: "0801.3" });
    expect(twice.ok && twice.readme).toBe(once.readme);
  });

  it("leaves everything outside the markers untouched", () => {
    const result = renderBadges(readme("![build](old)"), { version: "0.2.0", build: "0801.3" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readme.startsWith("# gccusage\n")).toBe(true);
    expect(result.readme.endsWith("A statusline.\n")).toBe(true);
  });

  it("escapes a version that would otherwise break the shields path", () => {
    const result = renderBadges(readme(PENDING), { version: "1.0.0-rc1", build: "0801.3" });
    expect(result.ok && result.readme).toContain("badge/version-1.0.0--rc1-blue");
  });

  it("greys the badge out while the build is still pending", () => {
    const pending = renderBadges(readme(PENDING), { version: "0.2.0", build: PENDING });
    expect(pending.ok && pending.readme).toContain("badge/build-pending-lightgrey");
    const real = renderBadges(readme(PENDING), { version: "0.2.0", build: "0801.1" });
    expect(real.ok && real.readme).not.toContain("lightgrey");
  });

  it("fails loudly when a marker is missing rather than appending", () => {
    for (const broken of [
      "# gccusage\n\nno markers at all\n",
      `# gccusage\n\n${BADGE_START}\n![build](x)\n`,
      `# gccusage\n\n![build](x)\n${BADGE_END}\n`,
      `# gccusage\n\n${BADGE_END}\n![build](x)\n${BADGE_START}\n`,
    ]) {
      const result = renderBadges(broken, { version: "0.2.0", build: "0801.3" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("badges:");
    }
  });
});

describe.skipIf(!nodeRunsTypeScript)("build-badge entry point", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-badge-"));
    fs.mkdirSync(path.join(dir, ".github"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(dir, "README.md"), readme(PENDING));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (): string =>
    execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "build-badge.ts")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GCCUSAGE_BADGE_ROOT: dir },
    });

  it("writes both files on a first run and increments on a second", () => {
    run();
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".github", "build-number.json"), "utf8"));
    expect(state.count).toBe(1);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain(
      `badge/build-${state.build}-brightgreen`,
    );
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("badge/version-1.2.3-blue");

    run();
    const after = JSON.parse(fs.readFileSync(path.join(dir, ".github", "build-number.json"), "utf8"));
    expect(after.count).toBe(2);
    expect(after.build).toBe(formatBuild(after.date, 2));
  });

  it("exits non-zero and leaves files alone when the README has no markers", () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# gccusage\n\nno markers\n");
    expect(() => run()).toThrow();
    expect(fs.existsSync(path.join(dir, ".github", "build-number.json"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# gccusage\n\nno markers\n");
  });
});
