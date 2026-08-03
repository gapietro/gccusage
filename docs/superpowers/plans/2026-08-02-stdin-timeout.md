# stdin Read Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the stdin read deadline from 1s to 5s and distinguish a timeout from an empty payload, so a slow arrival renders an explicit degraded line instead of a confident `$0.00` bar.

**Architecture:** `readStdin` gains two default parameters (an injectable stream and an injectable deadline) and returns `{raw, timedOut, timeoutMs}` instead of a bare string — matching the `{settings, error}` / `{stdin, error}` result-object idiom already used twice on this code path. `index.ts` gains one branch that writes a new `formatStdinTimeout` line and returns *before* `runStatusline`, leaving the statusline cache untouched exactly as the config-error and stdin-error paths already do.

**Tech Stack:** TypeScript, tsdown (bundler), vitest, Node >= 22.

**Spec:** `docs/superpowers/specs/2026-08-02-stdin-timeout-design.md`
**Issue:** [#87](https://github.com/gapietro/gccusage/issues/87) (audit finding REL-003, P2)

## Global Constraints

These apply to **every** task below.

- **Every commit that touches `src/` must run `npm run build` and stage the bundle.** `dist/index.js` is gitignored but force-tracked, so the command is `git add -f dist/index.js`. `gccusage setup` points `statusLine.command` at that file, so a src-only commit leaves `git pull` upgraders running the old code. CI's `bundle-drift` job fails the build on byte-inequality.
- **Never stage `AUDIT.md`.** It is deliberately untracked. It shows as `??` in `git status` and stays that way.
- **New test files must live under `src/**/__tests__/**/*.test.ts`.** `vitest.config.ts:5` pins `include` to that glob; a test outside it is silently never collected by `npm test` even though it passes when named directly.
- **`src/` imports use the `.js` extension** (tsdown rewrites specifiers). Do not use `.ts` — that convention belongs to `scripts/` only.
- **Every new test must be sabotage-verified**: break the thing it guards, watch it go red, restore. A test that passes against unfixed code is worse than no test. Task 3 Step 9 does this formally; do not skip it.
- **The full check before any commit:** `npm test && npm run typecheck`.

---

### Task 1: `readStdin` returns a result object with an injectable, env-configurable deadline

The seam and the deadline. No user-visible behavior changes in this task — `index.ts` is updated only enough to keep the tree compiling, and still renders the same bar it does today.

**Files:**
- Modify: `src/data/stdin-reader.ts:1-23`
- Modify: `src/index.ts:38-43`
- Create: `src/__tests__/stdin-timeout.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface StdinReadResult { raw: string; timedOut: boolean; timeoutMs: number }`
  - `readStdin(stream?: Readable, timeoutMs?: number): Promise<StdinReadResult>`
  - `resolveTimeoutMs(): number`
  - `DEFAULT_STDIN_TIMEOUT_MS: number` (= 5000)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/stdin-timeout.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import {
  readStdin,
  resolveTimeoutMs,
  DEFAULT_STDIN_TIMEOUT_MS,
} from "../data/stdin-reader.js";

/**
 * `readStdin` sat at 0% coverage because it read the global `process.stdin`
 * with no seam (#95 lists it as one of six such files). The stream and the
 * deadline are now parameters with production defaults, so the whole of it is
 * reachable in-process without spawning anything.
 */
describe("readStdin", () => {
  it("reports a timeout when nothing ever arrives", async () => {
    const stream = new PassThrough();

    const result = await readStdin(stream, 50);

    expect(result.timedOut).toBe(true);
    expect(result.raw).toBe("");
    // The applied deadline is echoed back rather than re-derived by the
    // caller, so the rendered message can name the real figure.
    expect(result.timeoutMs).toBe(50);
  });

  it("reports a timeout when the payload is truncated, keeping the partial bytes", async () => {
    const stream = new PassThrough();
    stream.write('{"cost":{"total_cost_usd":7.5}');   // no closing brace, never ends

    const result = await readStdin(stream, 50);

    expect(result.timedOut).toBe(true);
    expect(result.raw).toBe('{"cost":{"total_cost_usd":7.5}');
  });

  it("resolves immediately on a prompt writer, well before the deadline", async () => {
    const stream = new PassThrough();
    const payload = '{"cost":{"total_cost_usd":7.5}}';
    stream.end(payload);

    const started = Date.now();
    const result = await readStdin(stream, 5000);
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(false);
    expect(result.raw).toBe(payload);
    // Guards against the timer quietly becoming the resolution path: if `end`
    // stopped settling the promise, this would take 5s instead of ~0ms.
    expect(elapsed).toBeLessThan(1000);
  });

  it("rejects when the stream errors", async () => {
    const stream = new PassThrough();
    const failure = new Error("boom");
    queueMicrotask(() => stream.destroy(failure));

    await expect(readStdin(stream, 5000)).rejects.toThrow("boom");
  });
});

describe("resolveTimeoutMs", () => {
  const KEY = "GCCUSAGE_STDIN_TIMEOUT_MS";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("defaults to 5s when unset", () => {
    delete process.env[KEY];
    expect(resolveTimeoutMs()).toBe(DEFAULT_STDIN_TIMEOUT_MS);
    expect(DEFAULT_STDIN_TIMEOUT_MS).toBe(5000);
  });

  it("honours a valid override", () => {
    process.env[KEY] = "200";
    expect(resolveTimeoutMs()).toBe(200);
  });

  it.each(["", "   ", "abc", "0", "-1", "1.5", "Infinity"])(
    "falls back to the default on the unusable value %j",
    (value) => {
      process.env[KEY] = value;
      // A coerced NaN would make setTimeout fire immediately and turn every
      // single render into the degraded line — the loudest possible failure
      // from the quietest possible typo. Same posture as getTerminalWidth's
      // handling of a bad COLUMNS (src/utils/terminal.ts:28-32).
      expect(resolveTimeoutMs()).toBe(DEFAULT_STDIN_TIMEOUT_MS);
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/stdin-timeout.test.ts`
Expected: FAIL — `resolveTimeoutMs` and `DEFAULT_STDIN_TIMEOUT_MS` are not exported, and `readStdin` takes no arguments and resolves a string (so `result.timedOut` is `undefined`).

- [ ] **Step 3: Rewrite `src/data/stdin-reader.ts` lines 1-23**

Replace the import block and the whole `readStdin` function. Leave `parseStatusJson`, `StdinParseResult`, and `describe` below it **completely untouched** — the parser's contract is "a bad payload, not a slow one", and widening it is explicitly rejected in the spec.

```ts
import * as v from "valibot";
import type { Readable } from "node:stream";
import { StatusJsonSchema, type StatusJson } from "../types/status-json.js";

/**
 * Claude Code waits 600s for the statusline command (its hook spawn helper
 * computes `e.timeout ? e.timeout*1000 : 600000`, verified against the 2.1.220
 * binary), so nothing external pressured the old 1s deadline — we chose it, and
 * it was the only binding constraint. Claude Code also writes the payload and
 * immediately `end()`s stdin, so a read still incomplete after 5s is pathology
 * rather than a merely loaded machine (#87).
 */
export const DEFAULT_STDIN_TIMEOUT_MS = 5000;

/**
 * Overridable so tests can drive the real bundle at a deadline short enough to
 * keep, following the precedent of `GCCUSAGE_PRICING_URL` (PR #106).
 *
 * A malformed value degrades to the default rather than being coerced: a NaN
 * deadline makes `setTimeout` fire immediately, which would turn every render
 * into the degraded line.
 */
export function resolveTimeoutMs(): number {
  const raw = process.env["GCCUSAGE_STDIN_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STDIN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_STDIN_TIMEOUT_MS;
  return parsed;
}

export interface StdinReadResult {
  raw: string;
  /** True when the deadline expired. Never conflate with an empty `raw`. */
  timedOut: boolean;
  /** The deadline actually applied, so the caller can name it in a message. */
  timeoutMs: number;
}

/**
 * The old signature resolved `""` on timeout, which the caller could not tell
 * from "Claude Code sent nothing" — so a slow payload rendered a confident
 * $0.00 bar beside a non-zero `Today:` read from the daily store (#87).
 *
 * Both parameters exist for the tests; production has exactly one call site
 * (`src/index.ts`) and passes neither.
 */
export function readStdin(
  stream: Readable = process.stdin,
  timeoutMs: number = resolveTimeoutMs(),
): Promise<StdinReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        raw: Buffer.concat(chunks).toString("utf-8"),
        timedOut,
        timeoutMs,
      });
    };

    timer = setTimeout(() => {
      // Settle before destroying, not after: destroy() can emit synchronously,
      // and `settled` must already be true when those events land so a late
      // error cannot reject a promise we have decided to fulfil. The destroy
      // itself stays — the process cannot exit while it holds a live stdin,
      // and Claude Code waits for exit.
      settle(true);
      stream.destroy();
    }, timeoutMs);

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => settle(false));
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    stream.resume();
  });
}
```

- [ ] **Step 4: Update `src/index.ts` just enough to compile**

The full degraded-line branch lands in Task 3. For now, keep the existing behavior byte-for-byte while adapting to the new return type. Replace lines 38-43:

```ts
  // Read stdin
  const isTTY = process.stdin.isTTY;
  let raw = "";
  if (!isTTY) {
    const result = await readStdin();
    raw = result.raw;
  }
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run src/__tests__/stdin-timeout.test.ts`
Expected: PASS — 4 `readStdin` tests, 3 `resolveTimeoutMs` blocks (the `it.each` expands to 7 cases).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing bar is unchanged, so no other suite should move. If `stdin-resilience.test.ts` or `context-usage.test.ts` fail, you touched `parseStatusJson` — revert that; Step 3 says leave it alone.

- [ ] **Step 7: Build and commit**

```bash
npm run build
git add src/data/stdin-reader.ts src/index.ts src/__tests__/stdin-timeout.test.ts
git add -f dist/index.js
git commit -m "refactor: readStdin reports whether it timed out (#87)

Resolving \"\" on timeout was indistinguishable from Claude Code sending
nothing. The stream and the deadline become injectable parameters, which
also takes stdin-reader.ts from 0% coverage.

No behavior change yet: index.ts still renders the same bar."
```

---

### Task 2: `formatStdinTimeout`

The line the user actually reads. Pure function, no wiring — Task 3 calls it.

**Files:**
- Modify: `src/config/error-line.ts` (append after `formatStdinError`)
- Modify: `src/__tests__/error-line.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: nothing from Task 1 (the `timeoutMs` it formats is passed by Task 3).
- Produces: `formatStdinTimeout(timeoutMs: number): string`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/error-line.test.ts`. Add `formatStdinTimeout` to the existing import on line 2:

```ts
import { formatConfigError, formatStdinTimeout } from "../config/error-line.js";
```

Then append this describe block at the end of the file:

```ts
describe("formatStdinTimeout", () => {
  it("is a single line with no trailing newline", () => {
    expect(formatStdinTimeout(5000)).not.toContain("\n");
  });

  it("opens with the same bold-red marker as the other error lines", () => {
    expect(formatStdinTimeout(5000).startsWith("[1;31m⚠ gccusage[0m")).toBe(true);
  });

  it("names the deadline that was actually applied", () => {
    // Rendered from the argument, never hardcoded: a test driving the bundle
    // at 200ms must not read a line claiming "within 5s", or the assertion
    // pins a lie.
    expect(formatStdinTimeout(5000)).toContain("within 5s");
    expect(formatStdinTimeout(200)).toContain("within 200ms");
    expect(formatStdinTimeout(7500)).toContain("within 7.5s");
  });

  it("never renders a sub-second deadline as 0s", () => {
    // utils/format.ts's formatDuration floors to whole seconds and turns 200
    // into "0s", which is why this has its own formatter.
    expect(formatStdinTimeout(200)).not.toContain("0s");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/error-line.test.ts`
Expected: FAIL — `formatStdinTimeout` is not exported from `error-line.ts`.

- [ ] **Step 3: Append the implementation to `src/config/error-line.ts`**

Add at the end of the file, after `formatStdinError`:

```ts
/**
 * A payload that never arrived (#87), as distinct from one that arrived
 * unusable (`formatStdinError`). Naming the deadline is what separates
 * "Claude Code is wedged" from "Claude Code sent garbage" for the reader.
 *
 * Written to stdout and followed by a normal exit: Claude Code only renders
 * statusline output when the command exits 0, so a non-zero exit would blank
 * the bar and throw this message away.
 */
export function formatStdinTimeout(timeoutMs: number): string {
  return `${BOLD_RED}⚠ gccusage${RESET}  stdin did not arrive within ${formatDeadline(timeoutMs)} — Claude Code may be overloaded`;
}

/**
 * Not `formatDuration` from utils/format.ts: that floors to whole seconds and
 * renders a 200ms test deadline as "0s".
 */
function formatDeadline(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${ms / 1000}s`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/error-line.test.ts`
Expected: PASS, including the pre-existing `formatConfigError` tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Build and commit**

```bash
npm run build
git add src/config/error-line.ts src/__tests__/error-line.test.ts
git add -f dist/index.js
git commit -m "feat: add formatStdinTimeout error line (#87)

A third formatter beside the config and stdin-error lines, for a payload
that never arrived. Renders the deadline from its argument so a
test-injected 200ms deadline does not read as \"within 5s\"."
```

---

### Task 3: Wire the branch into `index.ts`, prove it against the real bundle, sabotage-verify

**Files:**
- Modify: `src/index.ts:38-54`
- Modify: `src/__tests__/stdin-timeout.test.ts` (append the end-to-end describe)

**Interfaces:**
- Consumes: `readStdin(): Promise<{raw, timedOut, timeoutMs}>` and `resolveTimeoutMs` from Task 1; `formatStdinTimeout(timeoutMs: number): string` from Task 2.
- Produces: the shipped behavior. Nothing downstream.

- [ ] **Step 1: Write the failing end-to-end tests**

Append to `src/__tests__/stdin-timeout.test.ts`. First extend the imports at the top of the file:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
```

Then append at the end of the file:

```ts
// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

const PAYLOAD = JSON.stringify({
  session_id: "00000000-0000-4000-8000-0000000000fe",
  model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
  workspace: { current_dir: "/tmp/x", project_dir: "/tmp/x" },
  cost: {
    total_cost_usd: 7.5,
    total_duration_ms: 60_000,
    total_api_duration_ms: 1000,
    total_lines_added: 0,
    total_lines_removed: 0,
  },
  context_window: {
    used_percentage: 42,
    context_window_size: 200_000,
    current_usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 90,
    },
    total_input_tokens: 100,
    total_output_tokens: 50,
  },
});

describe.skipIf(!distExists)("slow stdin against the shipped bundle", () => {
  let dir: string;

  beforeEach(() => {
    // A fresh HOME and cache per test: no daily store carried between cases,
    // and no statusline cache hit serving one test's bar to another.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-stdin-"));
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(opts: {
    payload: string | null;
    writeAfterMs: number;
    timeoutMs: number;
  }): Promise<{ stdout: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DIST], {
        env: {
          ...process.env,
          HOME: dir,
          XDG_CACHE_HOME: path.join(dir, "cache"),
          GCCUSAGE_STDIN_TIMEOUT_MS: String(opts.timeoutMs),
          COLUMNS: "120",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ stdout, status }));

      // On the timeout path the child has already destroyed its stdin by the
      // time we write, so the pipe is gone and the write raises EPIPE. That is
      // the expected outcome of the feature, not a failure — without this
      // handler it surfaces as an unhandled 'error' event and kills the runner.
      child.stdin.on("error", () => {});

      setTimeout(() => {
        if (opts.payload === null) child.stdin.end();
        else child.stdin.end(opts.payload);
      }, opts.writeAfterMs);
    });
  }

  it("shows the degraded line instead of a zeroed bar when the writer is slow", async () => {
    const { stdout, status } = await run({
      payload: PAYLOAD,
      writeAfterMs: 500,
      timeoutMs: 200,
    });

    expect(stdout).toContain("⚠ gccusage");
    expect(stdout).toContain("within 200ms");
    // The issue's literal acceptance criterion. Before the fix this rendered
    // "$0.00" beside a Today: figure read from the daily store.
    expect(stdout).not.toContain("$0.00");
    // Claude Code discards output from a non-zero exit, so the message would
    // never reach the user if this were anything but 0.
    expect(status).toBe(0);
    // Returning before runStatusline must leave the cache alone. Otherwise the
    // degraded bar is written under the empty payload's key and a second
    // timeout inside the TTL serves it back without reading stdin at all.
    expect(
      fs.existsSync(path.join(dir, "cache", "gccusage", "statusline-cache.json")),
    ).toBe(false);
  });

  it("renders the normal bar when the payload arrives promptly", async () => {
    const { stdout, status } = await run({
      payload: PAYLOAD,
      writeAfterMs: 0,
      timeoutMs: 2000,
    });

    // Guards against the fix firing on the happy path.
    expect(stdout).not.toContain("⚠");
    expect(stdout).toContain("$7.50");
    expect(status).toBe(0);
  });

  it("stays silent when stdin closes cleanly having sent nothing", async () => {
    const { stdout, status } = await run({
      payload: null,
      writeAfterMs: 0,
      timeoutMs: 2000,
    });

    // Deliberately unchanged: this is `gccusage < /dev/null` and pipe-based
    // smoke checks. Pinned so a later tidy-up cannot quietly widen the
    // degraded line to cover a case we decided to leave alone.
    expect(stdout).not.toContain("⚠");
    expect(stdout).toContain("$0.00");
    expect(status).toBe(0);
  });
});
```

- [ ] **Step 2: Run the end-to-end tests to verify they fail**

Run: `npx vitest run src/__tests__/stdin-timeout.test.ts`
Expected: the first test FAILS — the bundle still renders `$0.00` on the timeout path because `index.ts` has no branch yet. The other two should already pass.

If the *third* test fails here, stop: something already changed the clean-EOF path, which this plan does not touch.

- [ ] **Step 3: Add the branch to `src/index.ts`**

Extend the import on line 3 and replace lines 38-43 (the block Task 1 left in place). Everything from the `parseStatusJson` call downward stays exactly as it is.

```ts
import { formatConfigError, formatStdinError, formatStdinTimeout } from "./config/error-line.js";
```

```ts
  // Read stdin
  const isTTY = process.stdin.isTTY;
  let raw = "";
  if (!isTTY) {
    const { raw: payload, timedOut, timeoutMs } = await readStdin();
    if (timedOut) {
      // Returning here — before the parse and before runStatusline — keeps the
      // statusline cache untouched, matching the two paths above. It matters:
      // the empty-object bar used to be *written* to the cache under the empty
      // payload's key, so a second timeout inside the TTL served the wrong bar
      // from cache without even reading stdin.
      //
      // Partial bytes still report a timeout rather than being parsed. Claude
      // Code end()s stdin immediately after writing, so bytes without an end
      // mean truncation, and "stdin is not valid JSON" would misdiagnose the
      // cause in the one place the user gets to read (#87).
      process.stdout.write(formatStdinTimeout(timeoutMs));
      return;
    }
    raw = payload;
  }
```

- [ ] **Step 4: Rebuild — the end-to-end tests run the bundle, not the source**

Run: `npm run build`
Expected: succeeds. Skipping this makes Step 5 fail against the old bundle and look like the fix does not work.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/stdin-timeout.test.ts`
Expected: PASS — all unit tests plus all three end-to-end tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Confirm the shipped default really is 5s, by hand**

The end-to-end tests all inject a deadline, so none of them proves the production default. Check it directly:

```bash
node -e "process.stdout.write('')" | node dist/index.js
```

Expected: the normal `$0.00` bar (stdin closes immediately — clean EOF, not a timeout), returning promptly.

```bash
sleep 7 | /usr/bin/time -p node dist/index.js
```

Expected: the ⚠ line reading `within 5s`, and `real` around **5.0** — not 1.0, not 7.0. Time `node` itself, not the pipeline: `time (sleep 7 | node dist/index.js)` reports 7s regardless, because the shell waits for `sleep` to finish long after our process has printed and exited, which reads as a failure when it is not.

This is the only check that the default constant is wired through `resolveTimeoutMs` into the real binary — every automated test injects a deadline.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/__tests__/stdin-timeout.test.ts
git add -f dist/index.js
git commit -m "fix: render a degraded line when stdin never arrives (#87)

A slow payload rendered a confident \$0.00 bar beside a non-zero Today:
read from the daily store — self-contradictory, and timing-triggered, so
it appeared as an intermittent flicker rather than a reproducible failure.

The read now reports its own timeout and index.ts writes an explicit line
instead, returning before runStatusline so the statusline cache is left
untouched.

Two facts read out of the Claude Code 2.1.220 binary shaped this: the host
waits 600s for the statusline command, so the old 1s deadline was entirely
self-imposed; and empty stdout erases the bar rather than preserving the
previous one, which ruled out declining to render as a silent option."
```

- [ ] **Step 9: Sabotage-verify every new test**

This repo has a documented history of tests that assert nothing (see the `vacuous-tests` note). Each sabotage below must turn a **specific, named** test red. Run `npm run build` after each source edit — the end-to-end tests read the bundle — and restore with `git checkout` before the next one.

| # | Sabotage | Must fail |
|---|---|---|
| 1 | `DEFAULT_STDIN_TIMEOUT_MS = 1000` | `resolveTimeoutMs > defaults to 5s when unset` |
| 2 | Delete the `if (timedOut)` block from `index.ts` | `slow stdin... > shows the degraded line instead of a zeroed bar` |
| 3 | Make `resolveTimeoutMs` return `DEFAULT_STDIN_TIMEOUT_MS` unconditionally, ignoring the env var | `resolveTimeoutMs > honours a valid override` **and** `slow stdin... > shows the degraded line` |
| 4 | In `readStdin`, hardcode `timeoutMs: DEFAULT_STDIN_TIMEOUT_MS` in the resolved object | `readStdin > reports a timeout when nothing ever arrives` |
| 5 | In `formatDeadline`, return `${Math.floor(ms/1000)}s` always | `formatStdinTimeout > never renders a sub-second deadline as 0s` |
| 6 | In `readStdin`, drop the `end` handler so only the timer settles | `readStdin > resolves immediately on a prompt writer` (via the elapsed-time assertion) |
| 7 | Widen the `index.ts` branch to `if (timedOut \|\| !raw)` | `slow stdin... > stays silent when stdin closes cleanly having sent nothing` |

Sabotage 3 is the one that matters most: an env var the shipped bundle silently ignored would let the headline end-to-end test pass against unfixed code, which is exactly the config-injection trap recorded in `benchmarking-the-render-path`. Sabotage 7 is what makes the scope decision real rather than merely documented.

If any sabotage does **not** produce a failure, the corresponding test is vacuous — fix the test, do not move on.

- [ ] **Step 10: Restore and confirm green**

```bash
git checkout src/ && npm run build && npm test && npm run typecheck
git status --short
```

Expected: all green, and `git status` shows only `?? AUDIT.md`. If `dist/index.js` shows as modified, the working bundle drifted from the committed one — rebuild and amend, or CI's `bundle-drift` job will fail.

---

## Follow-up (not in this plan)

`readStdin` still **rejects** on a stream `error` event. That rejection hits the blanket `main().catch(() => process.exit(0))` at `src/index.ts:60`, so the bar blanks with no explanation — the same defect class as #87 under a different trigger. The spec puts it explicitly out of scope to keep this change surgical. File it as its own issue after this merges.
