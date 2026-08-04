import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseStatusJson } from "../data/stdin-reader.js";
import { stripAnsi } from "../utils/terminal.js";
import { PRICING_CACHE_VERSION } from "../cache/pricing-cache.js";

/**
 * Claude Code owns this payload format and evolves it. Before #83 the schema
 * was parsed as one unit, so a single field whose type changed upstream
 * discarded EVERY field and the bar rendered a confident `$0.00` next to a
 * `Today:` figure from the persisted store — internally contradictory, and
 * wrong in the direction that looks like real data.
 *
 * The contract now: a bad field costs that field. A payload that isn't an
 * object at all is a visible error, not a silent empty bar.
 */

const GOOD = {
  session_id: "s1",
  cost: { total_cost_usd: 7.5, total_lines_added: 3 },
  model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
  context_window: { used_percentage: 42, context_window_size: 200000 },
};

function parse(payload: unknown) {
  return parseStatusJson(JSON.stringify(payload));
}

describe("parseStatusJson field-level resilience", () => {
  it("keeps model and cost when context_window has a bad leaf (#83)", () => {
    const { stdin, error } = parse({
      ...GOOD,
      context_window: { ...GOOD.context_window, used_percentage: "42" },
    });

    expect(error).toBeUndefined();
    expect(stdin.cost?.total_cost_usd).toBe(7.5);
    expect(typeof stdin.model === "object" ? stdin.model.display_name : undefined).toBe("Opus 4.6");
  });

  it("drops only the bad leaf, not its whole block", () => {
    const { stdin } = parse({
      ...GOOD,
      context_window: { ...GOOD.context_window, used_percentage: "42" },
    });

    const cw = stdin.context_window;
    expect(typeof cw === "object" ? cw?.used_percentage : undefined).toBeUndefined();
    // The sibling survives: dropping the entire block would cost the window
    // size and the compaction countdown too.
    expect(typeof cw === "object" ? cw?.context_window_size : undefined).toBe(200000);
  });

  it("drops only the bad block when a whole block has the wrong type", () => {
    const { stdin, error } = parse({ ...GOOD, context_window: "nonsense" });

    expect(error).toBeUndefined();
    expect(stdin.context_window).toBeUndefined();
    expect(stdin.cost?.total_cost_usd).toBe(7.5);
  });

  it("keeps sibling cost fields when one cost leaf goes bad", () => {
    const { stdin } = parse({ ...GOOD, cost: { total_cost_usd: "7.5", total_lines_added: 3 } });

    expect(stdin.cost?.total_cost_usd).toBeUndefined();
    expect(stdin.cost?.total_lines_added).toBe(3);
  });

  it("keeps the payload when model changes shape", () => {
    const { stdin, error } = parse({ ...GOOD, model: { id: 42 } });

    expect(error).toBeUndefined();
    expect(stdin.cost?.total_cost_usd).toBe(7.5);
  });

  it("still accepts a wholly valid payload unchanged", () => {
    const { stdin, error } = parse(GOOD);

    expect(error).toBeUndefined();
    expect(stdin.cost?.total_cost_usd).toBe(7.5);
    const cw = stdin.context_window;
    expect(typeof cw === "object" ? cw?.used_percentage : undefined).toBe(42);
  });
});

describe("parseStatusJson unusable input", () => {
  it("reports an error for invalid JSON", () => {
    const { stdin, error } = parseStatusJson("{not json");

    expect(error).toBeDefined();
    expect(stdin).toEqual({});
  });

  it("reports an error for a non-object payload", () => {
    expect(parseStatusJson('"hello"').error).toBeDefined();
  });

  it("reports an error for an array payload", () => {
    // valibot's object schema accepts an array and yields {}, so without an
    // explicit guard this degrades to a silent empty bar.
    expect(parseStatusJson("[1,2,3]").error).toBeDefined();
  });

  it("reports NO error for empty stdin", () => {
    // The ordinary no-input case (a TTY, or the read timing out). Treating
    // this as an error would put a red line on the bar for every user who
    // runs the binary by hand.
    const { stdin, error } = parseStatusJson("");

    expect(error).toBeUndefined();
    expect(stdin).toEqual({});
  });

  it("reports NO error for whitespace-only stdin", () => {
    expect(parseStatusJson("   \n ").error).toBeUndefined();
  });
});

/**
 * The acceptance criterion from #83, driven through the shipped bundle. The
 * unit tests above prove the parse layer; only this proves what a user sees,
 * which is where the `$0.00` actually appeared.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-stdin-"));
  const cacheDir = path.join(dir, "cache", "gccusage");
  fs.mkdirSync(cacheDir, { recursive: true });
  // Seeded so the render never considers a pricing refresh.
  fs.writeFileSync(
    path.join(cacheDir, "pricing.json"),
    JSON.stringify({ version: PRICING_CACHE_VERSION, timestamp: Date.now(), data: {} }),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function render(payload: string, sessionId: string): string {
  const out = execFileSync(process.execPath, [DIST], {
    input: payload.replace("__SID__", sessionId),
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      COLUMNS: "200",
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return stripAnsi(out);
}

const PAYLOAD = (pct: string) =>
  `{"session_id":"__SID__","cost":{"total_cost_usd":7.50},` +
  `"model":{"id":"claude-opus-4-6","display_name":"Opus 4.6"},` +
  `"context_window":{"used_percentage":${pct},"context_window_size":200000}}`;

describe.skipIf(!distExists)("malformed stdin through the real bundle", () => {
  it("still renders model and session cost when context_window is malformed", () => {
    const out = render(PAYLOAD('"42"'), "e2e-bad-pct");

    expect(out).toContain("Opus 4.6");
    expect(out).toContain("$7.50");
    // The specific regression: the whole bar collapsed to this.
    expect(out).not.toMatch(/^\s*\$0\.00/);
  });

  it("renders the same cost and model as a well-formed payload", () => {
    const good = render(PAYLOAD("42"), "e2e-good");
    const bad = render(PAYLOAD('"42"'), "e2e-bad");

    for (const fragment of ["Opus 4.6", "$7.50"]) {
      expect(good).toContain(fragment);
      expect(bad).toContain(fragment);
    }
    // Only the context segment is lost — the percentage is genuinely unknown.
    expect(good).toContain("42%");
    expect(bad).not.toContain("42%");
  });

  it("shows an error line rather than a $0.00 bar for an unusable payload", () => {
    const out = render("[1,2,3]", "e2e-array");

    expect(out).toContain("⚠ gccusage");
    expect(out).not.toContain("$0.00");
  });
});
