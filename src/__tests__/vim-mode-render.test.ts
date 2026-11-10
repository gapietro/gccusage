import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripAnsi } from "../utils/terminal.js";
import {
  reserveRefusedUrl,
  suppressPricingRefresh,
  type RefresherSuppression,
} from "./helpers/pricing-refresher.js";

/**
 * #141 through the shipped bundle. A `vim.mode` naming an `Object.prototype`
 * member used to resolve to an inherited function as the segment's colour,
 * throw in `resolveColor`, and — because `main().catch()` swallows it — erase
 * the WHOLE bar: exit 0, zero bytes on stdout. Only a real spawn sees that.
 *
 * Two layers now stop it: `vim-mode.ts` looks colours up in a `Map`, and the
 * renderer drops any non-string `fg`/`bg`. This test goes red only when BOTH
 * are reverted; each layer's own unit test (vim-mode-widget.test.ts,
 * renderer.test.ts "#141") pins it individually.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

let dir: string;
let cacheHome: string;
let refusedPricingUrl: string;
let refresher: RefresherSuppression;

beforeAll(async () => {
  refusedPricingUrl = await reserveRefusedUrl();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-vim-"));
  cacheHome = path.join(dir, "cache");
  fs.mkdirSync(path.join(cacheHome, "gccusage"), { recursive: true });
  refresher = suppressPricingRefresh(cacheHome, refusedPricingUrl);
});

afterEach(() => {
  refresher.assertNotSpawned();
  fs.rmSync(dir, { recursive: true, force: true });
});

function render(mode: string): string {
  const payload = JSON.stringify({
    session_id: `e2e-vim-${mode}`,
    cost: { total_cost_usd: 7.5 },
    model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
    vim: { mode },
  });
  const out = execFileSync(process.execPath, [DIST], {
    input: payload,
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      ...refresher.env,
      COLUMNS: "200",
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return stripAnsi(out);
}

describe.skipIf(!distExists)("vim mode through the real bundle (#141)", () => {
  it("renders a real mode (control)", () => {
    const out = render("NORMAL");
    expect(out).toContain("Opus 4.6");
    expect(out).toContain("NORMAL");
  });

  it.each([["constructor"], ["toString"], ["__proto__"], ["hasOwnProperty"]])(
    "renders the whole bar for vim.mode %j instead of erasing it",
    (mode) => {
      const out = render(mode);
      expect(out.trim()).not.toBe("");
      expect(out).toContain("Opus 4.6");
      expect(out).toContain("$7.50");
      expect(out).toContain(mode);
    },
  );
});
