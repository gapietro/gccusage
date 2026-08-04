import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PRICING_REFRESH_STAMP_FILE } from "../data/pricing-refresh.js";

/**
 * The acceptance test for #84, driven through the real shipped bundle.
 *
 * Every unit test here can pass on a build that still stalls: the stall was
 * never the fetch's duration but the process outliving the written bar, and
 * only measuring the child's wall-clock exit catches that. The originally
 * proposed fix — a Promise.race deadline around the fetch — wrote the bar in
 * 320ms and still exited at 10520ms.
 *
 * The blackhole is a local socket that accepts and never answers, not an
 * unroutable address. A host that returns ICMP-unreachable fails the fetch
 * fast, and this test would then pass against the broken code too.
 *
 * That same property is what makes a refused port the right CONTROL. The
 * timing test below measures both and compares them, rather than asserting an
 * absolute wall-clock. The absolute form was a machine-speed assertion in
 * disguise (#123): a render costs ~117ms here, of which ~25ms is bare Node
 * startup and the blackhole accounts for **1ms** — so a 500ms budget left
 * about 4x headroom on a figure that is ~99% unrelated to the property under
 * test, and it failed at 531ms on a loaded machine. Comparing two renders
 * taken back to back cancels machine speed out, while the regression being
 * guarded (10520ms) still exceeds the margin by an order of magnitude.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

/**
 * How much slower a blackholed render may be than one whose endpoint fails
 * immediately. Both are spawned Node processes on the same machine moments
 * apart, so this absorbs variance only, not absolute speed.
 */
const STALL_MARGIN_MS = 1000;

/** Backstop for the case where BOTH renders stall, which the diff cannot see. */
const CEILING_MS = 5000;

let dir: string;
let server: net.Server;
let sockets: net.Socket[];
let port: number;
let refusedPort: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-blackhole-"));
  sockets = [];

  server = net.createServer((socket) => {
    // Accept and hold. Never write, never close: the connection succeeds and
    // the response never arrives, which is what a captive portal or a
    // firewalled proxy does to this request.
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Bound then released: connections are refused immediately. The control.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  refusedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `slot` names the XDG_CACHE_HOME subdirectory. The timing test needs two
 * renders that each genuinely reach the refresh decision, and the attempt
 * stamp one writes would put the other inside the backoff window — so they
 * must not share a cache directory, or the second render never spawns a
 * refresher and the comparison measures nothing.
 */
function render(pricingUrl: string, slot = "cache"): { elapsedMs: number; output: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_CACHE_HOME: path.join(dir, slot),
    // No pricing cache is seeded, so the render sees a stale table and must
    // decide to refresh — the exact path that used to reach the network.
    GCCUSAGE_PRICING_URL: pricingUrl,
  };

  const started = Date.now();
  const output = execFileSync(process.execPath, [DIST], {
    input: JSON.stringify({
      session_id: "blackhole-test",
      cost: { total_cost_usd: 1.23 },
      model: { id: "claude-opus-5", display_name: "Opus 5" },
    }),
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { elapsedMs: Date.now() - started, output };
}

describe.skipIf(!distExists)("statusline against a blackholed pricing endpoint", () => {
  it("costs no more than a render whose endpoint fails immediately", () => {
    // Control first, so it carries any cold-start cost. That biases the
    // difference downward, i.e. toward passing — the safe direction for a
    // guard whose regression is measured in seconds.
    const control = render(`http://127.0.0.1:${refusedPort}/pricing.json`, "control");
    const blackhole = render(`http://127.0.0.1:${port}/pricing.json`, "blackhole");

    // execFileSync returns on process EXIT, not on first output — that is the
    // measurement that matters, because Claude Code waits for exit too.
    expect(
      blackhole.elapsedMs - control.elapsedMs,
      `blackholed render took ${blackhole.elapsedMs}ms vs ${control.elapsedMs}ms for a refused endpoint`,
    ).toBeLessThan(STALL_MARGIN_MS);

    // The diff is blind to a build where both stall; this is not.
    expect(blackhole.elapsedMs).toBeLessThan(CEILING_MS);
    expect(control.elapsedMs).toBeLessThan(CEILING_MS);
  });

  it("still renders a priced bar rather than degrading to nothing", () => {
    const { output } = render(`http://127.0.0.1:${port}/pricing.json`);

    // Guards against passing the timing assertion by crashing instantly.
    expect(output.trim().length).toBeGreaterThan(0);
    expect(output).toContain("1.23");
  });

  it("still attempts the refresh out of band", () => {
    render(`http://127.0.0.1:${port}/pricing.json`);

    // Without this the timing test would also pass on a build that simply
    // stopped refreshing pricing altogether.
    const stamp = path.join(dir, "cache", "gccusage", PRICING_REFRESH_STAMP_FILE);
    expect(fs.existsSync(stamp)).toBe(true);
  });
});
