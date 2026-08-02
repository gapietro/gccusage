import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

const BUDGET_MS = 500;

let dir: string;
let server: net.Server;
let sockets: net.Socket[];
let port: number;

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
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

function render(): { elapsedMs: number; output: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_CACHE_HOME: path.join(dir, "cache"),
    // No pricing cache is seeded, so the render sees a stale table and must
    // decide to refresh — the exact path that used to reach the network.
    GCCUSAGE_PRICING_URL: `http://127.0.0.1:${port}/pricing.json`,
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
  it(`renders and exits in under ${BUDGET_MS}ms`, () => {
    const { elapsedMs } = render();

    // execFileSync returns on process EXIT, not on first output — that is the
    // measurement that matters, because Claude Code waits for exit too.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it("still renders a priced bar rather than degrading to nothing", () => {
    const { output } = render();

    // Guards against passing the timing assertion by crashing instantly.
    expect(output.trim().length).toBeGreaterThan(0);
    expect(output).toContain("1.23");
  });

  it("still attempts the refresh out of band", () => {
    render();

    // Without this the timing test would also pass on a build that simply
    // stopped refreshing pricing altogether.
    const stamp = path.join(dir, "cache", "gccusage", "pricing-refresh-attempt.json");
    expect(fs.existsSync(stamp)).toBe(true);
  });
});
