# Real Claude Code payload fixtures

Three real statusline payloads, captured from live Claude Code sessions, paired
with the `RenderContext` values a real `buildRenderContext()` run derived from
them. Written for issue #47: 12 of 25 registered widgets render in no default
layout and had never been exercised against a real payload — hand-written
fixtures encode what we *believe* the pipeline produces, not what it actually
produces.

## Provenance

- **Claude Code version**: 2.1.220
- **Captured**: 2026-07-31
- **How**: `~/.claude/settings.json`'s `statusLine.command` was temporarily
  pointed at a `tee` wrapper (`node /path/to/dist/index.js`, piped through
  `tee -a captured-stdin.jsonl` before the real binary), so every real
  statusline invocation across concurrent Claude Code sessions on this
  machine appended its stdin JSON as one line to a scratch JSONL file. That
  produced 111 captured lines (plus one synthetic probe line from an
  unrelated wrapper smoke test, excluded). Three lines were selected by
  `context_window.used_percentage` / `model.id` / `context_window_size` to
  cover a spread of context usage: `opus5-1m-mid` (~27%), `fable5-1m-low`
  (6%), `opus5-1m-early` (11%).

## `stdin` vs `derived` are two different instants

`stdin` is the raw payload as it was tee-captured live. `derived` was computed
*later* — up to roughly 30 minutes later, in this corpus — when the fixture
generator ran `buildRenderContext()` against that same session's real,
still-growing JSONL transcript. They are the same session at two different
instants, not a single simultaneous snapshot: the transcript backing `derived`
had more turns/tokens appended between when `stdin` was captured and when the
generator ran. `derivedAt` (epoch ms) records the second instant — when
`derived` was computed — not when `stdin` was captured. Pin `Date.now()` to
`derivedAt` when testing elapsed-time widgets against `derived` values;
treating it as the capture instant for `stdin` would be off by that gap.

## How each fixture was produced

For each selected raw line:

1. Parsed and validated through `StatusJsonSchema` (the same schema
   `runStatusline` uses).
2. Passed to the **real** `buildRenderContext()`, running against the
   machine's real `$HOME` — this is required for it to reach the real JSONL
   transcripts on disk and produce real derived values (token counts, cost,
   burn rate, block state). This is the entire point: the `derived` block is
   *recorded*, not invented.
3. Only *after* deriving, the raw payload was sanitized (see below) and
   stored as `stdin` alongside the recorded `derived` block.

**The `derived` block must never be hand-edited.** If it needs to change
(e.g. a schema field is added), regenerate it — see "Refreshing" below —
don't patch the JSON by hand.

## `derived` vs `controlled`: why turnCount lives in a separate block

`turnCount` was kept out of `derived` because the pre-#129 `turn-tracker.ts`
persisted a counter in a shard file per session id
(`<cacheDir>/turns/<shardKey(sessionId)>.json`), gated to run only when the
active layout included `turn-counter`. Running the generator for three real
session ids in one process created a *fresh* shard per session id, and a
fresh shard always started at `count: 1` — so a "recorded" `turnCount` would
have encoded only generation order (which fixture ran first), not real
pipeline output. A real turn count accumulated over a live session and
couldn't be reconstructed retroactively once that had happened.

#129 deleted that store: `turnCount` is now `countHumanTurns(sessionEntries)`,
derived fresh on every render directly from the transcript's
`origin.kind === "human"` entries, with nothing persisted and nothing to
shard or reset. A regenerated fixture's `turnCount` is therefore just as much
a real recording as anything under `derived`, and the original reason it was
excluded — generation-order sensitivity — no longer applies. It COULD now be
promoted into `derived` and captured automatically alongside the rest of that
block. It still lives under `controlled` here only because doing that means
regenerating the fixture corpus (see "Refreshing the corpus" below), which was
out of scope for this documentation pass — not because of any property that
still sets it apart from `derived`. (`context-from-fixture.ts` reconstructing
`RenderContext` by hand from recorded fields, rather than re-running
`buildRenderContext()`, is true of every field under `derived` too — see
`context-from-fixture.ts:24-53` — so it does not distinguish `turnCount` and
is not the reason.)

The current value, `9`, is a leftover from before #129: it was the figure
observed for the `opus5` session under the OLD shard-per-session-id counter,
in a standalone single-session probe run chosen specifically to dodge that
counter's cross-session interleaving hazard (see above). Under the current
derivation that provenance is no longer meaningful — `9` is not a recording of
what `countHumanTurns` produces for this fixture's transcript, just a
pre-existing test input that was never re-verified against the new code path.
This is harmless: `context-from-fixture.ts` treats `controlled.turnCount` as a
plain input value either way, not as something it trusts to match a live
transcript, so the widget tests built on it remain valid regardless of what
the number "means." It is flagged here so nobody mistakes `9` for a recording
of real `countHumanTurns` output.
`fixture-types.ts` documents this on the `controlled` field. Everything under
`derived`, by contrast, IS a real recording from `buildRenderContext()` and
must never be hand-edited.

## Sanitization

Some captured payloads came from the user's other concurrent Claude Code
sessions on the same machine (different repos entirely), so identifying
values were stripped or replaced before the sanitized payload was written to
disk:

- `session_id` → a fixed placeholder UUID (`00000000-…-000000000000`)
- `prompt_id` → a fixed placeholder UUID (`…-000000000001`)
- `session_name` → `"Example session"`
- `cwd`, `transcript_path`, `workspace.current_dir`, `workspace.project_dir`,
  `workspace.added_dirs[]` → home directory prefix replaced with
  `/home/testuser` (the `homePlaceholder` field), and the project-name
  segment (`/projects/<name>`) replaced with `/projects/demo-project`.
  `transcript_path` also encodes the whole path a second time with slashes
  turned into dashes (`-Users-<username>-projects-<name>`) — that
  dash-encoded form is genericized separately, and the *original* session id
  embedded in the transcript filename is swapped for the placeholder too.
  Both were verified necessary: the straightforward home-prefix swap alone
  left the real OS username and other projects' names inside
  `transcript_path`.
- `workspace.repo` → `{ host: "github.com", owner: "example", name: "demo" }`

Verify the sanitized fixtures carry none of the above by scanning for: the OS
username running the capture, the original session/prompt ids of every
selected payload, other real project names, and any `/Users/` or `/home/`
path that isn't the `/home/testuser` placeholder. Do not commit a gate with a
real username or session id hardcoded into it — parameterize instead, e.g.:

```bash
USERNAME="$(whoami)"
grep -rlE "${USERNAME}" src/__tests__/fixtures/real-payloads/*.json || echo CLEAN
grep -rlE "/Users/" src/__tests__/fixtures/real-payloads/*.json || echo CLEAN
# plus: grep for the original session_id/prompt_id of each selected raw line,
# and for any other project/session names visible in the raw capture.
```

## Files

- `fixture-types.ts` — the `RealPayloadFixture` interface. `AggregatedMetrics.byModel`
  is a `Map`, which doesn't survive `JSON.stringify`; it (and `costByModel`) are
  stored as `[key, value][]` entries and typed accordingly.
- `opus5-1m-mid.json`, `fable5-1m-low.json`, `opus5-1m-early.json` — the fixtures.

## Refreshing the corpus

1. Point `statusLine.command` at a `tee` wrapper as described above and use
   Claude Code normally for a while to accumulate raw lines into a scratch
   JSONL file.
2. Recreate the generator script this file's history describes (a throwaway
   `src/__tests__/zz-capture.test.ts` that imports `buildRenderContext`,
   selects lines by predicate, derives against the real `$HOME`, sanitizes,
   and writes the three JSON files) — it is deliberately not kept in the repo
   so it can't be run by accident against a machine other than the one that
   captured the corpus.
3. Run it with `npx vitest run src/__tests__/zz-capture.test.ts`. There is no
   turn store to worry about anymore — #129 deleted `turn-tracker.ts` and the
   layout gate that guarded it; `turnCount` is derived fresh from the
   transcript's `origin.kind === "human"` entries on every
   `buildRenderContext()` call, so there is nothing persisted and nothing to
   shard or reset between fixtures.
4. Re-run the sanitization scan above (OS username, original session/prompt
   ids, other project/session names, any non-placeholder `/Users/` or
   `/home/` path) and extend `sanitize()` if anything matches.
5. Confirm each fixture's `derived.metrics.session` still has non-zero token
   counts — an all-zero block means `buildRenderContext` found no matching
   transcripts and the fixture is useless.
6. Re-pick a `controlled.turnCount` value if it needs to change. Unlike the
   old `turn-tracker.ts` era, an interleaved generation run is now a safe
   source: `countHumanTurns` is a pure function of one session's own
   transcript, with nothing shared across session ids to corrupt (see the
   "why turnCount lives in a separate block" section above). The old
   standalone-single-session-probe requirement was a workaround for the
   deleted shard-per-session-id store always starting a fresh shard at
   `count: 1`; that hazard no longer exists, so this step no longer carries
   it.
7. Delete the generator script again before committing.
