# stdin read timeout — design

Issue: [#87](https://github.com/gapietro/gccusage/issues/87) (audit finding REL-003, P2)
Date: 2026-08-02

## Problem

`readStdin` resolves the empty string after 1000ms and destroys stdin:

```ts
const timeout = setTimeout(() => {
  process.stdin.destroy();
  resolve("");            // indistinguishable from "no data was sent"
}, 1000);
```

The caller cannot tell a timeout from a genuinely empty payload, so both flow into
`parseStatusJson("")`, which deliberately returns `{stdin: {}}` with no error. The
bar then renders from an empty object: a confident `$0.00` beside a non-zero
`Today:` read from the daily store, which is self-contradictory on its face.

Because it is timing-triggered it presents as an intermittent flicker on a loaded
machine rather than a reproducible failure, and statusline mode has no visible
stderr to leave a trace in.

## Host behavior (Claude Code 2.1.220)

Read out of the installed binary at `~/.local/share/claude/versions/2.1.220`.
Both facts constrain the design and neither was in the issue.

**The 1s deadline is self-imposed, and 600x tighter than the host's.** The hook
spawn helper computes its timeout as `e.timeout ? e.timeout*1000 : xm`, with
`xm = 600000`. Claude Code waits **600 seconds** for the statusline command,
overridable per-hook via `statusLine.timeout`. Nothing external pressures us
toward 1s.

**Empty stdout erases the bar; it does not preserve the previous one.**

```js
// executeStatusLineCommand
if (s.status === 0) { const l = s.stdout.trim()...; if (l) { return l } }
return;                                     // empty stdout -> undefined

// runner
const l = await r(); if (t.aborted) return; if (i(l), l) ...   // i(l) runs with undefined

// onResult
statusLineText = de                         // undefined -> bar vanishes
```

So "decline to render" means the bar disappears for that cycle. The previous bar
survives only on the *abort* path — when a newer render supersedes an in-flight
one, the runner returns before calling `onResult`.

Two corollaries:

- Claude Code writes the payload and immediately `stdin.end()`s it. A slow arrival
  is OS scheduling or pipe-buffer backpressure, not the host dribbling data.
  Therefore bytes-without-`end` at the deadline means **truncation**.
- Output is only rendered when `status === 0`. A non-zero exit would blank the bar
  and discard whatever we wrote, so the degraded line must exit 0.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| What a timeout renders | Explicit degraded line | Matches the precedent set by #83/#88: this codebase already decided a visible error beats confident wrong data. A blank bar reads as "the tool crashed" with nothing to explain it. |
| Deadline | 5s | Claude Code writes at spawn, so a read incomplete after 5s is pathology, not load. Far inside the host's 600s, short enough that a stuck read still exits rather than parking a process. |
| Clean EOF, 0 bytes | Unchanged (stays silent) | Keeps the change surgical and preserves `gccusage < /dev/null` and pipe-based smoke checks, which the existing comment in `stdin-reader.ts` explicitly defends. |
| Partial bytes at deadline | Reported as a timeout | `end()` is immediate on the host, so partial bytes mean truncation. Routing that to `stdin is not valid JSON` would misdiagnose the cause in the one place the user gets to read. |
| Message content | Deadline only, no byte count | One line in a status bar; "received 1,847 of ? bytes" costs width without changing what the user does next. |
| Exit code | 0, unchanged | The host discards output from a non-zero exit. |

### Rejected alternatives

**`readStdin` rejects with a typed `StdinTimeoutError`.** Makes a timeout an
exception when it is an expected, handled outcome. `index.ts`'s one blanket catch
(`main().catch(() => process.exit(0))`) is the graceful-degradation net, and
adding throw/catch semantics beside it invites exactly the over-broad-catch
hazard #88 was about.

**Pass the flag into `parseStatusJson`.** Overloads a *parser* with a concern
about *transport*. `parseStatusJson` is directly unit-tested by two suites
(`stdin-resilience`, `context-usage`) that would all need the new argument for no
benefit.

**Raise the deadline only.** Preserves the defect and just makes it rarer; the
`$0.00`-beside-`Today: $7.50` contradiction stays reachable.

## Architecture

`readStdin` returns a result object rather than a bare string, matching the idiom
already used twice on this exact path — `loadSettings()` → `{settings, error}`
and `parseStatusJson()` → `{stdin, error}`:

```ts
export interface StdinReadResult {
  raw: string;
  timedOut: boolean;
  /** The deadline actually applied, so the caller can name it in the message
   *  without re-deriving it from the environment. */
  timeoutMs: number;
}

export function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  timeoutMs: number = resolveTimeoutMs(),
): Promise<StdinReadResult>
```

On expiry it destroys the stream exactly as today — the pipe must be released
before the process can exit — and resolves `{raw: <bytes so far>, timedOut: true}`.

`resolveTimeoutMs()` reads `GCCUSAGE_STDIN_TIMEOUT_MS` and defaults to 5000. The
env override follows the precedent of `GCCUSAGE_PRICING_URL` (PR #106), added for
the same reason: it is what keeps the end-to-end test fast enough to keep.

A malformed or non-positive value falls back to 5000 rather than being coerced,
matching `getTerminalWidth`'s handling of a bad `COLUMNS` (`src/utils/terminal.ts:28-32`).
A coerced `NaN` would make `setTimeout` fire immediately and turn every render
into the ⚠ line — the loudest possible failure from the quietest possible typo.

The two default parameters are the only seams the tests need. `readStdin` has
exactly one production caller (`src/index.ts:42`), so neither default is exercised
by anything but that call.

`parseStatusJson` is untouched, keeping its contract "a bad payload, not a slow
one".

`index.ts` gains one branch between the read and the parse:

```ts
const { raw, timedOut, timeoutMs } = await readStdin();
if (timedOut) {
  process.stdout.write(formatStdinTimeout(timeoutMs));
  return;                    // cache untouched, as the two paths above already do
}
```

Returning before `runStatusline` leaves the statusline cache untouched, matching
the config-error (`index.ts:34`) and stdin-error (`index.ts:52`) paths. This
matters: on the current code the empty-object bar is *written to* the cache under
the empty payload's key, so a second timeout inside the TTL serves the wrong bar
from cache.

`error-line.ts` gains `formatStdinTimeout(ms)` beside the existing two formatters,
reusing `BOLD_RED`/`RESET` and the `⚠ gccusage` prefix:

```
⚠ gccusage  stdin did not arrive within 5s — Claude Code may be overloaded
```

The deadline is rendered from the value actually applied, not a hardcoded `5s`,
so a test running at `GCCUSAGE_STDIN_TIMEOUT_MS=200` reads `within 200ms` and a
user who raised it reads their own figure. Sub-second values render as `<n>ms`,
whole seconds as `<n>s`; `src/utils/format.ts` already owns this kind of
formatting and is the place to look before adding a new helper.

## Case matrix

| stdin state | Behavior | Status |
|---|---|---|
| TTY (hand-run) | Read skipped entirely (`index.ts:41`), `{}` → ordinary bar | Unchanged |
| Payload arrives | Normal bar | Unchanged |
| Clean EOF, 0 bytes | Quiet empty bar | Unchanged |
| Deadline expires, 0 bytes | ⚠ line, cache untouched | New |
| Deadline expires, partial bytes | ⚠ line, not a parse error | New |
| Stream `error` event | Rejects → blanket catch → exit 0, bar blanks | Unchanged — see below |

## Explicitly out of scope

The stream `error` path still rejects, hits the blanket catch, and blanks the bar
with no explanation. That is the same defect class as #87 under a different
trigger, and it is left alone here to keep the change surgical. It deserves its
own issue.

## Testing

New `src/__tests__/stdin-timeout.test.ts`.

**Unit, in-process** (against a `PassThrough`, `timeoutMs: 50`):

1. Stream writes nothing → resolves `{raw: "", timedOut: true, timeoutMs: 50}`,
   confirming the applied deadline is echoed back rather than re-derived.
2. Stream writes a partial payload and never ends → `timedOut: true`, `raw` holds
   the partial bytes.
3. Stream writes and ends promptly → `{timedOut: false}` with the full payload,
   resolving well before the deadline. Guards against the timer silently becoming
   the resolution path.

**End-to-end, real spawn** (`spawnSync` on the shipped `dist/index.js`, following
`cli-exit-code.test.ts` including its `describe.skipIf(!distExists)` guard):

4. `GCCUSAGE_STDIN_TIMEOUT_MS=200` with a writer delayed 500ms → stdout contains
   the ⚠ line and **does not contain `$0.00`**. This is the issue's literal
   acceptance criterion.
5. Same harness, prompt writer, real payload → normal bar, no ⚠. Guards against
   the fix firing on the happy path.
6. Clean EOF with zero bytes stays silent, pinning the scope decision so a later
   tidy-up does not quietly widen it.

**Sabotage verification.** Per this repo's `vacuous-tests` history, every test is
verified by breaking what it guards. Each of these must turn a specific test red:

- revert the deadline to 1s;
- delete the `timedOut` branch in `index.ts`;
- make `resolveTimeoutMs` ignore the env var.

The third matters most: an env var the shipped bundle silently ignored would let
test 4 pass against unfixed code, which is precisely the config-injection trap
recorded in `benchmarking-the-render-path`.

## Acceptance criteria

- A slow writer produces the ⚠ line, never a zeroed bar (issue's stated criterion).
- `src/data/stdin-reader.ts` goes from 0% coverage to covered, closing one of the
  six files named in #95.
- `npm run build` is run and `dist/index.js` staged in the same commit — the
  bundle is what `statusLine.command` points at, and CI's `bundle-drift` job
  fails otherwise.
