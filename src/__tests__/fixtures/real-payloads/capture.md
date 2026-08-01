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

## How each fixture was produced

For each selected raw line:

1. Parsed and validated through `StatusJsonSchema` (the same schema
   `runStatusline` uses).
2. Passed to the **real** `buildRenderContext()`, running against the
   machine's real `$HOME` — this is required for it to reach the real JSONL
   transcripts on disk and produce real derived values (token counts, cost,
   burn rate, block state, turn count). This is the entire point: the
   `derived` block is *recorded*, not invented.
3. Only *after* deriving, the raw payload was sanitized (see below) and
   stored as `stdin` alongside the recorded `derived` block.

**The `derived` block must never be hand-edited.** If it needs to change
(e.g. a schema field is added), regenerate it — see "Refreshing" below —
don't patch the JSON by hand.

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
  turned into dashes (`-Users-<user>-projects-<name>`) — that dash-encoded
  form is genericized separately, and the *original* session id embedded in
  the transcript filename is swapped for the placeholder too. Both were
  verified necessary: the straightforward home-prefix swap alone left the
  real OS username and other projects' names inside `transcript_path`.
- `workspace.repo` → `{ host: "github.com", owner: "example", name: "demo" }`

Verified clean via:

```bash
grep -rlE "gpietro|60d7554b|99199410|gccusage/\.claude" src/__tests__/fixtures/real-payloads/ || echo CLEAN
```

plus additional manual sweeps for `/Users/`, the three fixtures' original
session/prompt ids, and the other sessions' project and session names — all
came back clean.

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
3. Run it with `npx vitest run src/__tests__/zz-capture.test.ts`.
4. Re-run the sanitization grep above and extend `sanitize()` if it fails.
5. Confirm each fixture's `derived.metrics.session` still has non-zero token
   counts — an all-zero block means `buildRenderContext` found no matching
   transcripts and the fixture is useless.
6. Delete the generator script again before committing.
