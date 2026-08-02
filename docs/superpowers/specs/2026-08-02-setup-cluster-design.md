# `gccusage setup` robustness — design

Date: 2026-08-02
Issues: #90 (OPS-004), #88 (OPS-002), #89 (OPS-003), #105

## Problem

`gccusage setup` writes `statusLine.command` into `~/.claude/settings.json`. Three
independent defects live in that one function, and a fourth sits in `package.json`.

**#90 — the interpreter path is version-scoped.** `src/cli.ts:115` passes
`process.execPath`. Node resolves symlinks for `execPath`, so on a Homebrew install
that is the Cellar path, not the symlink that points at it:

```
$ ls -l $(which node)
/opt/homebrew/bin/node -> ../Cellar/node/26.5.0_1/bin/node
$ node -e "console.log(process.execPath)"
/opt/homebrew/Cellar/node/26.5.0_1/bin/node
```

`brew upgrade node` deletes `26.5.0_1`. The statusline then stops rendering with no
error the user can see, at a moment with no obvious connection to the cause. nvm,
nodenv, fnm and volta all have the same shape.

**#88 — a non-object settings.json makes `setup` a no-op that reports success.**
`JSON.parse` is assigned straight into `Record<string, unknown>` with no shape check.
On `null` or a scalar the property assignment throws; `main().catch(() => process.exit(0))`
in `src/index.ts:47` swallows it; `setup` exits 0 having printed nothing and changed
nothing. On an **array** nothing throws at all — the assignment succeeds and
`JSON.stringify` silently drops non-index properties, so the file is rewritten
without the `statusLine` key.

**#89 — the write is not atomic and takes no backup.** `src/cli.ts:118` is a single
`writeFileSync` to the live path. A backup is taken only when the existing file
*fails to parse*; the common case — a valid settings file being rewritten — gets
none. That file holds the user's permissions, hooks, MCP servers, model selection
and statusline.

**#105 — `engines.node: ">=18"` is untested and contradicted.** `devEngines.runtime`
asks for `>=23.6.0`, CI runs 22 and 24, and `scripts/*.ts` run directly under Node
and need native type stripping. Nothing exercises 18.

## Decisions

Three calls were made during design, each of which had a defensible alternative.

**Interpreter: scan `PATH` for a stable path; fall back to `execPath` with a warning.**
Rejected: writing bare `node`. It is what a hand-written config usually contains and
it survives upgrades, but Claude Code runs as a desktop app as well as a terminal
app, and a desktop-launched process may carry a minimal `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`) that omits `/opt/homebrew/bin`. That trades an
upgrade-time break for a launch-context break. Also rejected: keeping `execPath` and
only warning — it makes the failure diagnosable without preventing it.

**Node floor: a single supported version, `>=22`, aligned everywhere.** Rejected:
bumping `engines` while leaving `tsdown`'s `target: "node18"` — that keeps a second,
untested version number in the tree, which is the ambiguity the issue is about,
merely relocated. Also rejected: keeping `>=18` and adding a CI job to prove it —
the `scripts/` and badge paths cannot pass on 18 without a compile step, and there
is no evidence of a user on 18.

**Unusable settings file: refuse and change nothing — for both the structurally
wrong and the unparseable case.** Issue #88 is internally inconsistent here: its
*Fix* section says "take the backup-and-restart path", its *acceptance criteria*
says "print an error and exit non-zero". We take the second, and extend it to the
unparseable case that today backs up and clobbers. Rationale: a convenience command
should not replace the user's permissions/hooks/MCP config with `{statusLine}` on
the strength of a `.bak` the user does not know exists. Consequence, stated plainly:
this is a **behaviour change beyond the filed issue** — `setup` against an
unparseable settings.json now fails instead of succeeding.

## Design

### 1. `src/utils/node-path.ts` (new)

```ts
interface NodePathProbe {
  execPath: string;
  pathEntries: string[];
  realpath(p: string): string;   // throws if absent
}

export function versionSegment(p: string): string | null;
export function resolveStableNodePath(probe?: NodePathProbe): { path: string; warning?: string };
```

Three steps, short-circuiting:

1. If `execPath` has no version-like segment, return it unchanged with no warning.
   Covers `/usr/bin/node` and `/usr/local/bin/node` without touching the filesystem.
2. Otherwise scan `pathEntries` in order for a `<dir>/node` whose `realpath` equals
   `realpath(execPath)` **and** which itself has no version segment. Return the first
   hit. This is the Homebrew case: `/opt/homebrew/bin/node`.
3. Otherwise return `execPath` with a warning naming the version segment found.
   This is nvm/nodenv/fnm/volta, where no stable absolute path exists:

   ```
   Warning: this Node path contains a version (v22.1.0) and will stop working
            when that version is removed. Re-run `gccusage setup` after
            upgrading Node.
   ```

If `realpath(execPath)` itself throws — the running binary was deleted or replaced
mid-session — step 2 is skipped and the function proceeds to step 3, returning
`execPath` with the warning. There is nothing to compare candidates against, and
guessing at a replacement would be worse than saying so.

`versionSegment` matches `/\/(v?\d+\.\d+\.\d+[^/]*)/` and returns the captured
segment. Verified against the real installer shapes:

| Layout | Path | Matches |
|---|---|---|
| Homebrew | `Cellar/node/26.5.0_1/bin/node` | yes |
| Homebrew versioned formula | `Cellar/node@22/22.1.0/bin/node` | yes |
| nvm | `versions/node/v22.1.0/bin/node` | yes |
| nodenv | `versions/22.1.0/bin/node` | yes |
| volta | `image/node/22.1.0/bin/node` | yes |
| Homebrew per-major symlink | `/opt/homebrew/opt/node@22/bin/node` | **no** — correct, it is stable |

PATH order is respected rather than preferring a "best" candidate: the user's own
precedence is the most defensible tie-break, and any stable candidate that resolves
to the same binary is equally correct.

Injecting the probe is what makes step 2 testable without a real Homebrew tree.
The default probe reads `process.execPath`, `process.env.PATH` split on
`path.delimiter`, and `fs.realpathSync`.

### 2. `writeFileAtomic` in `src/utils/atomic-json.ts`

Extract the existing temp-name-plus-rename body of `writeJsonAtomic` into
`writeFileAtomic(filePath: string, contents: string)`. `writeJsonAtomic` becomes a
one-line caller, unchanged in behaviour.

`runSetup` calls `writeFileAtomic` directly because it needs
`JSON.stringify(settings, null, 2) + "\n"` — settings.json is a file the user reads
and edits, so it keeps its 2-space formatting and trailing newline. Adding an indent
option to `writeJsonAtomic` instead would put a formatting concern inside a
cache-write helper; separating the write mechanism from the encoding is the cleaner
boundary, and it is the same split #100 will want.

### 3. `runSetup` control flow

```
ensure ~/.claude exists
if settings.json exists:
    raw    = readFileSync            -> on error: throw "could not be read (<errno message>)"
    parsed = JSON.parse(raw)         -> on error: throw "is not valid JSON (<reason>)"
    if not a plain object:              throw "contains <null|a JSON array|a JSON string|...>, not a JSON object"
    settings = parsed
    writeFileAtomic(settings.json.bak, raw)      <- backup, verbatim bytes
{path, warning} = resolveStableNodePath()
settings.statusLine = { type: "command", command: buildStatusLineCommand(path, scriptPath) }
writeFileAtomic(settings.json, JSON.stringify(settings, null, 2) + "\n")
print success; print warning if present
```

The ordering is load-bearing in three ways:

- The backup is taken **after** validation, so a refused file leaves no `.bak` and no
  write of any kind.
- `.bak` now exists on the **success** path — the common case #89 is actually about.
- `.bak` is no longer the consolation prize for a clobber, because there is no
  longer a clobber.

"Plain object" is `typeof x === "object" && x !== null && !Array.isArray(x)`. The
array case is not hypothetical; see #88 above.

Error message shapes, both prefixed with `gccusage: ` by the caller:

```
gccusage: /Users/you/.claude/settings.json contains null, not a JSON object. Fix or move it, then re-run `gccusage setup`.
gccusage: /Users/you/.claude/settings.json is not valid JSON (Unexpected token o in JSON at position 1). Fix or move it, then re-run `gccusage setup`.
gccusage: /Users/you/.claude/settings.json could not be read (EACCES: permission denied). Fix or move it, then re-run `gccusage setup`.
```

All three end with the same instruction, and none is actionable without the path, so
the path leads. The parse-error reason is passed through from `JSON.parse` verbatim
rather than reworded — its position offset is the most useful part.

`buildStatusLineCommand` and `shellQuote` are unchanged. The audit confirmed the
quoting is already correct; only the path being quoted was wrong.

### 4. Error posture in `src/index.ts`

The CLI branch gets its own try/catch:

```ts
if (args.length > 0) {
  try {
    await runCli(args);
  } catch (err) {
    console.error(`gccusage: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  return;
}
```

The outer `main().catch(() => process.exit(0))` stays exactly as it is. It is correct
for statusline mode — never breaking the user's prompt is the entire reason it
exists — and the bug was only that it also covered the CLI.

### 5. `package.json` / `tsdown.config.ts`

| Field | Before | After |
|---|---|---|
| `engines.node` | `>=18` | `>=22` |
| `devEngines.runtime.version` | `>=23.6.0` | `>=22.18.0` |
| `tsdown` `target` | `node18` | `node22` |

`22.18` is the real threshold: unflagged type stripping for `scripts/*.ts`. The CI
matrix (22, 24) is unchanged and now matches the claim. The comment in `ci.yml`
noting that `>=18` is "untested here and tracked separately" is updated, since it no
longer is.

## Testing

Every test below must fail when the change it guards is reverted; a test that passes
against the old code is a defect in the test.

**`resolveStableNodePath`** — pure, injected probe:

- Homebrew shape (execPath in Cellar, PATH contains `/opt/homebrew/bin/node`
  resolving to it) returns `/opt/homebrew/bin/node`. Fails if the function ever
  simply returns `execPath` — this is the #90 regression test.
- nvm shape (only version-scoped candidates) returns `execPath` **and** a warning
  containing `v22.1.0`.
- `/usr/bin/node` is returned as-is, with no `realpath` calls made on PATH entries.
- A PATH entry whose `realpath` differs from the running binary is not selected.

**`runSetup` via `runCli(["setup"])`**, with `HOME` pointed at a tmpdir — the pattern
already used by the `today` tests in `src/__tests__/cli.test.ts`:

- Unrelated keys (`model`, `permissions`) survive.
- `.bak` is written on the success path and contains the exact pre-setup bytes.
- Each of `null`, `"oops"`, `[]`, `{oops` throws, writes nothing, creates no `.bak`,
  and leaves the original file byte-identical.

**Exit codes, spawned as a real process** — following the precedent in
`statusline-width.test.ts`, which execs `dist/index.js` because vitest's resolver
papers over what a real spawn catches:

- `node dist/index.js setup` with a tmpdir `HOME` containing `null` exits 1 with
  non-empty stderr. Before the fix this exits 0 silently, so the test fails on the
  old code — it is the regression test for #88's second half.
- `node dist/index.js setup` on the success path still exits 0.

The design originally also called for "statusline mode still exits 0 on a forced
error", to guard against over-correcting the scope. **That test cannot be written
honestly and is dropped.** Every I/O path the render pipeline touches is now
individually defended — `readJsonValidated` swallows read and parse failures,
`writeCache` and each branch of `daily-cost-tracker` carry their own try/catch — so
no reachable sabotage (a file where `XDG_CACHE_HOME` should be, an unreadable HOME,
malformed stdin) actually produces a throw for the outer handler to catch. A test
asserting exit 0 there would pass against every possible implementation, including a
broken one. Scoping is instead guaranteed structurally: the new try/catch is added
*inside* the `args.length > 0` branch and `main().catch(() => process.exit(0))` is
left byte-for-byte unmodified, which a reviewer can verify from the diff.

**Deliberately not tested, and why.** #89's literal acceptance criterion — that the
settings file is never *observed* in a partial state — is not testable from inside
this suite without racing a reader against a writer, which would be a flaky test
asserting a timing property rather than the mechanism. What is tested is the
mechanism: `writeFileAtomic` leaves no `.tmp` sibling behind on success, and a failed
rename leaves the target's previous contents intact. Recording this rather than
writing a green test that asserts nothing.

## Out of scope

- #100 (five hand-rolled cache-persistence blocks) — `writeFileAtomic` is extracted
  here only because #89 needs it; the cache call sites are not touched.
- #99, #97, #98 — unrelated to the setup path.

## Commit discipline

`npm run build` and `git add -f dist/index.js` in the same commit as any `src/`
change, or CI's `bundle-drift` job fails. `gccusage setup` points
`statusLine.command` at that bundle, so a src-only commit leaves `git pull`
upgraders running the old code.
