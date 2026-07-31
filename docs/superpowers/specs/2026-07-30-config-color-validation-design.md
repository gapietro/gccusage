# Reject invalid config colors loudly

**Date:** 2026-07-30
**Issue:** #42
**Follows:** PR #43 (named color resolution), PR #41 (issue #40), PR #39 (issue #36)

## Problem

`ColorSchema` (`src/config/schema.ts`) accepts any string for a widget's `fg`/`bg` and validates
nothing. Values that are neither a `NAMED_COLORS` key nor a clean hex color still reach chalk,
whose `hexToRgb` uses an *unanchored* `/[a-f\d]{6}|[a-f\d]{3}/i` — so it finds a hex run inside
a string that was never a hex color and paints an unrelated color:

| config value | painted at `chalk.level = 3` | what the user meant |
|---|---|---|
| `"196"` | `48;2;17;153;102` (`#119966`, green-teal) | ansi256 196, a red |
| `"255"` | `48;2;34;85;85` (`#225555`, dark teal) | ansi256 255, near-white |
| `"21"` | `48;2;0;0;0` (black) | ansi256 21, a blue |
| `"#12345"` | `48;2;17;34;51` (`#112233`) | a typo |
| `"grey1"` | `48;2;0;0;0` (black) | a typo for `grey` |

Issue #42 opened as "should we implement ansi256?" and answered itself: implementing it needs a
disambiguation rule for 3-digit codes (`"196"` is a valid ansi256 code *and* a valid 3-digit hex
under chalk's parsing), an ansi256 → RGB conversion inside `colorDistance` so the `ΔE < 8`
separator rule keeps predicting what is painted, and a second color space in a pipeline that is
otherwise all truecolor.

**Decision: do not implement ansi256.** Instead, reject at config-load anything that is neither a
known name nor a clean hex color. That converts a silent wrong color into an actionable message,
and catches the typo class (`"grey1"`, `"#12345"`) as a side effect.

### Why "reject at load" is not free today

`loadSettings` (`src/config/loader.ts`) wraps the whole read-parse-validate in
`try { ... } catch { return DEFAULT_SETTINGS }`. Adding a schema constraint alone would make a
single bad color silently discard the user's **entire** config and render the stock bar — a
*quieter* failure than the wrong color it replaces. Validation only pays off together with a
channel that shows the error.

Statusline mode has exactly one reliable channel: the string it writes to stdout. There is no
visible stderr, and `gccusage` has only `today` / `setup` / `help`. So the error goes in the
statusline itself.

## Design

### 1. Validation predicate — `src/render/colors.ts`

```ts
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isValidColor(color: string): boolean {
  const trimmed = color.trim();
  return HEX_COLOR.test(trimmed) || Object.hasOwn(NAMED_COLORS, trimmed.toLowerCase());
}
```

Lives beside `NAMED_COLORS` and `resolveColor` so the name list stays a single source of truth.
It must accept exactly what `resolveColor` can resolve, and applies the same normalization —
`trim()`, then `toLowerCase()` for the name lookup, and `Object.hasOwn` rather than a truthiness
check for the reason documented on `resolveColor` (inherited `Object.prototype` members would
otherwise validate as color names).

The hex arm is **anchored**, unlike chalk's. That is the point of the change: `#12345` and
`#abcd` are typos, not colors, even though chalk finds a hex run inside them.

### 2. Schema — `src/config/schema.ts`

```ts
const ColorSchema = v.pipe(
  v.string(),
  v.check(isValidColor, "must be a color name or #rgb/#rrggbb hex"),
);
```

valibot attaches a path to each issue, so `lines.0.widgets.2.bg` is available via
`v.getDotPath(issue)` with no manual bookkeeping.

The existing comment on `ColorSchema` describes the old lenient behavior ("an unrecognized name
or an unparseable hex value falls back to black at render time rather than erroring here") and is
replaced by one describing the new contract: a name or an anchored hex, anything else is a load
error, ansi256 deliberately unsupported (issue #42).

### 3. Loader — return the failure instead of swallowing it

```ts
export type ConfigLoad = { settings: Settings; error?: string };

export function loadSettings(): ConfigLoad
```

Only `src/index.ts` and `src/__tests__/loader.test.ts` call it, so changing the return type is
contained.

| case | result |
|---|---|
| file absent | `{ settings: DEFAULT_SETTINGS }` — silent, unchanged |
| unreadable | `{ settings: DEFAULT_SETTINGS, error }` |
| malformed JSON | `{ settings: DEFAULT_SETTINGS, error }` |
| schema mismatch (wrong type, bad color) | `{ settings: DEFAULT_SETTINGS, error }` |
| valid | `{ settings: merged }` |

A missing file stays silent: not having a config is the normal case, not a failure.

Validation runs through `v.safeParse` rather than `v.parse` in a `try`, so the issues arrive
typed with no `ValiError` narrowing; `JSON.parse` keeps its own `try`/`catch`.

The `error` is a single-line string built from whichever failure occurred:

- schema issues → first issue as `` `${dotPath}: ${message} (got ${received})` ``, then
  `` ` (+${n} more)` `` when `issues.length > 1`. Use `v.getDotPath(issue)`; when it is `null`
  (a root-level issue) omit the `path: ` prefix rather than printing `null`.

  Two behaviors of valibot@1 verified against the installed copy, both load-bearing here:
  `issue.received` **already carries its own quotes** (`"196"` comes back as the 5-character
  string `"\"196\""`), so the template must not add another pair; and a plain `v.parse` already
  collects every issue rather than stopping at the first, so the `(+N more)` count is available
  without passing `{ abortEarly: false }`.
- `SyntaxError` from `JSON.parse` → `` `invalid JSON: ${err.message}` ``.
- anything else (read error) → `` `cannot read config: ${message}` ``.

Every reason for discarding the file now produces an error, so this is one mechanism rather than
a color-specific special case.

### 4. `index.ts` — the error line replaces the bar

```ts
const { settings, error } = loadSettings();
if (error) {
  process.stdout.write(formatConfigError(error));
  return;
}
```

Returning *here* — before the stdin read and before `runStatusline` — matters for the cache: the
statusline cache is neither read nor written on this path, so a stale cached bar can never be
served over the error, and the first prompt after a fix renders normally instead of replaying a
cached error.

`formatConfigError` lives in its own small module (`src/config/error-line.ts`) rather than inside
`index.ts`, so it is testable without invoking `main()`. It takes the error string and the config
path and returns one line:

```
⚠ gccusage config  ~/.config/gccusage/settings.json — lines.0.widgets.2.bg: must be a color name or #rgb/#rrggbb hex (got "196")
```

- `⚠ gccusage config` is wrapped in a literal `\x1b[1;31m` … `\x1b[0m` so it cannot be mistaken
  for a normal segment. The escape is written directly rather than through chalk: `chalk.level`
  is 0 when stdout is a pipe and is only forced to 3 inside `powerline.ts`, so using chalk here
  would mean importing that module for its side effect to color a single line.
- `⚠` is U+26A0, not a Nerd Font glyph — it renders in the same terminals the default `▶`
  separator targets.
- `$HOME` in the path is collapsed to `~` so the line stays short.
- No trailing newline, matching what `runStatusline` returns.

### 5. What does not change

- **`resolveColor`, `normalizeColor`, `colorDistance`.** Untouched, including `normalizeColor`'s
  deliberate mirror of chalk's unanchored regex. That mirror is still correct and still needed:
  widgets compute their own hex backgrounds at render time (threshold colors), and themes are
  code, so not every color reaching chalk comes from the validated config.
- **The non-powerline path.** `colorize`'s `startsWith("#")` fallbacks stay; they are now
  unreachable from config values but remain the guard for programmatic ones.
- **`powerline.theme` and widget `type`.** An unknown theme name or widget type is the same class
  of silent-fallback problem but is not a color; out of scope here, noted as follow-up on #42.
- **Shipped defaults.** All hex, all valid — the default bar is byte-identical after this change.

## Testing

### `isValidColor`

Table-driven, so adding a name to `NAMED_COLORS` without it validating fails:

| input | expected | why |
|---|---|---|
| every `NAMED_COLORS` key | `true` | the map is the source of truth |
| `"RED"`, `"Red"`, `" red "` | `true` | same normalization as `resolveColor` |
| `"#abc"`, `"#AABBCC"` | `true` | both hex lengths, case-insensitive |
| `"196"`, `"255"`, `"21"`, `"9"` | `false` | the ansi256 codes from #42 |
| `"#12345"`, `"#abcd"`, `"#gg0000"` | `false` | anchored hex rejects near-misses |
| `"abc"`, `"aabbcc"` | `false` | a missing `#` is a typo, not hex |
| `"grey1"`, `"banana"`, `""` | `false` | unknown names |
| `"constructor"`, `"toString"` | `false` | `Object.hasOwn`, not truthiness |

### Loader

- bad color → `error` is non-empty **and** `settings` deep-equals `DEFAULT_SETTINGS`
- the error text contains the dot path (`lines.0.widgets.2.bg`) and the offending value
- two bad colors → error mentions the first and carries `(+1 more)`
- malformed JSON → error mentioning JSON; missing file → **no** error
- valid config (including a named `bg`) → no error, and merging behaves as the existing tests
  already assert
- existing `loader.test.ts` cases updated for the `{ settings, error }` shape

### `formatConfigError`

- single line, no newline, contains the config path with `$HOME` collapsed to `~`
- begins with the red-wrapped marker and the message survives intact

### Regression

- a widget configured `bg: "196"` yields a config error, not `48;2;17;153;102`
- a widget configured `bg: "red"` still renders `48;2;255;0;0` (PR #43's behavior is preserved)

### Verification

- `npm test` green, `npm run typecheck` clean
- `npm run build`, then exercise both paths against the real config: a good config renders the
  normal bar, a config with `"bg": "196"` renders the error line
- confirm the shipped default bar is byte-identical

## Risks

**This is deliberately stricter than what renders today.** Any value that currently "works" by
accident through chalk's unanchored regex now blanks the bar into an error line until the user
fixes it. That is the intent — a wrong color that looks plausible is worse than a message — but
it is a behavior change, not a pure bug fix, and it should be called out in the PR description.

The error line is loud by construction: it appears on every prompt until the config is fixed.
That is the chosen trade-off (see the "why reject at load is not free" section) — a config error
that is easy to ignore is the bug being fixed, not the fix.

## Commit requirements

`dist/index.js` is gitignored but force-tracked, and `gccusage setup` points
`statusLine.command` at it. Every commit touching `src/` must run `npm run build` and stage the
bundle with `git add -f dist/index.js`.
