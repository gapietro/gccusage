# gccusage

<!-- badges:start -->
![version](https://img.shields.io/badge/version-1.0.0-blue)
[![ci](https://github.com/gapietro/gccusage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gapietro/gccusage/actions/workflows/ci.yml)
<!-- badges:end -->

A powerline-style statusline for [Claude Code](https://claude.com/claude-code). Displays model info, costs, context usage, git status, and more in a compact, color-coded terminal bar.

```
 Opus 5 ▶ $23.53 ▶ [===-------] 27% (1.00M) ▶ ~697.0k left ▶ $13.27/hr ▶
 gccusage ▶ main ▶ +2 ~5 -1 ▶ +649 -66 ▶ Today: $23.53 ▶
```

## Prerequisites

- **Node.js 22+** — check with `node -v`
- **Claude Code** installed and working

## Quick Start

```bash
git clone https://github.com/gapietro/gccusage.git
cd gccusage
npm install && npm link
gccusage setup
```

Restart Claude Code and you'll see the statusline.

### Verify it works

```bash
echo '{}' | gccusage
```

You should see a rendered statusline (mostly empty, but colored). If that works, restart Claude Code — the full statusline will appear with live data.

### Check today's spend

```bash
gccusage today
```

Works standalone — no need to be inside Claude Code.

### Commands

| Command | What it does |
|---------|--------------|
| `gccusage` | Statusline mode — reads the status JSON on stdin and writes one bar |
| `gccusage setup` | Point Claude Code's `statusLine` at this install |
| `gccusage today` | Print today's usage report, broken down by model |
| `gccusage help` | Usage summary |

### Alternative: global install from GitHub

```bash
npm install -g github:gapietro/gccusage
gccusage setup
```

### Deploy to another machine

1. Install Node.js 22+ (e.g. `brew install node` on macOS)
2. Clone the repo: `git clone https://github.com/gapietro/gccusage.git`
3. `cd gccusage && npm install && npm link`
4. `gccusage setup`
5. Restart Claude Code

### What `gccusage setup` does

Adds the following to `~/.claude/settings.json` (creates the file if missing, preserves existing settings). If the file already exists, it writes a `settings.json.bak` backup of the previous contents before making any changes. If the existing file is not a JSON object (e.g. `null`, a bare string, an array) or is not valid JSON at all, `setup` refuses to touch it, exits with status 1, and leaves it exactly as it was:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/gccusage/dist/index.js"
  }
}
```

### Manual setup

If you prefer to configure it yourself, add the `statusLine` key above to `~/.claude/settings.json`, replacing the path with the absolute path to your `dist/index.js`.

Claude Code pipes JSON status data via stdin on each render. gccusage parses it and outputs ANSI-colored powerline segments.

## Configuration

Create `~/.config/gccusage/settings.json` to customize. You only need to specify the keys you want to override — everything else uses defaults.

Every setting, with its default:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lines` | array | 2-line layout | Widget layout, one entry per rendered line |
| `lines[].widgets` | array | — | The widgets on that line, in order |
| `lines[].flex` | `left` \| `right` \| `center` \| `space-between` | `left` | How the line fills the terminal width |
| `powerline.enabled` | boolean | `true` | Powerline segments with `▶` separators; `false` renders plain colored text |
| `powerline.theme` | string | `default` | `default`, `ocean`, `forest`, `sunset`, `minimal` |
| `powerline.separator` | string | `▶` | Separator between differently-colored segments |
| `powerline.separatorThin` | string | `│` | Separator used when neighbouring backgrounds are too close to tell apart |
| `compact.mode` | `auto` \| `always` \| `never` | `auto` | Collapse both lines into one |
| `compact.threshold` | number | `80` | Terminal width below which `auto` collapses |
| `alerts.sessionWarn` | number | `5` | Session cost (USD) that turns `session-cost` amber |
| `alerts.sessionDanger` | number | `15` | Session cost (USD) that turns it red |
| `alerts.dailyWarn` | number | `10` | Daily cost (USD) that turns `today-spend` amber |
| `alerts.dailyDanger` | number | `25` | Daily cost (USD) that turns it red |
| `cache.statuslineTtlMs` | number | `5000` | How long a rendered bar is reused between renders |
| `cache.pricingTtlMs` | number | `86400000` | How long fetched model pricing is reused (24h) |
| `costSource` | `auto` \| `stdin` \| `calculated` | `auto` | Where the session cost comes from — see below |

### Editor autocomplete

Point the file at the published JSON Schema and most editors will autocomplete widget types, option lists and defaults, and flag typos as you write:

```json
{
  "$schema": "https://raw.githubusercontent.com/gapietro/gccusage/main/config-schema.json",
  "powerline": { "theme": "ocean" }
}
```

The schema is generated from the code — widget types from the registry, defaults from the shipped settings — and a test fails if the two ever disagree, so it cannot silently fall behind a newly added widget. gccusage itself ignores the `$schema` key.

### Change theme

```json
{
  "powerline": { "theme": "ocean" }
}
```

Available themes: `default`, `ocean`, `forest`, `sunset`, `minimal`

Some themes have subtle gradient ramps between segment backgrounds. For `minimal`, `forest`,
and (to a lesser extent) `ocean`, most consecutive segments are close enough in color that
the wide `▶` separator would not read against them, so the thin `│` is drawn instead — this
is deliberate (see `separatorThin` below), not a bug. It only applies to a custom layout
whose widgets don't set their own `bg`; the default layout's widgets all set one, so the
theme's colors never come into play there.

### Separators

```json
{
  "powerline": { "separator": "▶", "separatorThin": "│" }
}
```

`separator` is drawn between segments of different colors. When two neighbouring
segments resolve to backgrounds that are the same — or too close to tell apart,
which happens when, say, context usage and the compact countdown both cross their
warning thresholds — the wide glyph would not read against them, so `separatorThin`
is drawn in the previous segment's text color instead.

### Plain (non-powerline) mode

```json
{
  "powerline": { "enabled": false }
}
```

Segments are rendered as plain colored text with no separator glyphs between
them. Nothing is inserted for you, so a layout that reads well in powerline
mode will run together in plain mode — put explicit `separator` widgets where
you want the breaks:

```json
{
  "lines": [
    {
      "widgets": [
        { "type": "model" },
        { "type": "separator", "separator": " | " },
        { "type": "session-cost" }
      ]
    }
  ],
  "powerline": { "enabled": false }
}
```

### Custom layout

```json
{
  "lines": [
    {
      "widgets": [
        { "type": "model", "fg": "#ffffff", "bg": "#1a5fb4" },
        { "type": "session-cost", "fg": "#ffffff", "bg": "#26a269" },
        { "type": "context-percent", "fg": "#ffffff", "bg": "#0d7377" }
      ],
      "flex": "left"
    }
  ]
}
```

`lines` replaces the default layout wholesale rather than merging with it, so
list every widget you want. `flex` controls how the line uses leftover width:
`left` (default), `right`, `center`, or `space-between`.

### Cost alert thresholds

```json
{
  "alerts": {
    "sessionWarn": 5,
    "sessionDanger": 15,
    "dailyWarn": 10,
    "dailyDanger": 25
  }
}
```

### Cost source

```json
{
  "costSource": "auto"
}
```

- `auto` (default) — use the session cost Claude Code reports in `cost.total_cost_usd`,
  and fall back to computing it from the transcript when that field is absent.
- `stdin` — same as `auto`; the same fallback applies, since a missing field leaves
  nothing to read.
- `calculated` — always price the transcript yourself, from token counts and
  fetched model pricing, ignoring what Claude Code reports.

The burn rate always follows the same source as the session total, so the bar
never shows a stdin-priced rate beside a transcript-priced total.

Model pricing is fetched from the LiteLLM feed and cached for 24h. When the
fetch fails, an offline snapshot committed at `src/data/fallback-pricing.ts`
takes over. If a model is missing from both — a model newer than the snapshot,
seen while offline — its tokens cannot be priced, and any figure computed
without them is marked with a `?`:

```
 Opus 4.6 ▶ $0.33? ▶ Today: $4.10? ▶ [===-------] 30% (200.0k)
```

The `?` means the number is real but incomplete, not that it is zero. Costs
Claude Code reports itself are never marked, since no missing price can affect
them. Refresh the snapshot with `npm run pricing`.

### Compact mode

Collapses both lines into a single line when the terminal is narrower than
`threshold` columns (default 80), keeping segments in `priority` order —
lower numbers survive. Width comes from the live terminal when stdout is a
TTY, otherwise from the `COLUMNS` variable that Claude Code injects when it
runs the statusline (it reads its own TTY and passes the value down, so it
tracks resizes). If neither is available the width is unknown, and `auto`
never collapses the bar rather than guessing.

```json
{
  "compact": {
    "mode": "auto",
    "threshold": 80
  }
}
```

Modes: `auto` (collapse below threshold), `always`, `never`

Long `project` and `git-branch` segments can also be shortened on their own,
independently of the settings above: whenever a line does not fit the
terminal on its own, its shrinkable segments are trimmed — widest first —
down toward an ellipsis, never below a small floor (8 characters, including
the ellipsis) below which a name stops distinguishing one project or branch
from another. This takes no configuration. On a terminal wide enough for the
line to fit as-is, nothing is shortened; if trimming every shrinkable segment
down to the floor is still not enough, the line's tail is truncated as
before.

## Widgets

The default layout uses eleven of these: `model`, `session-cost`,
`context-percent`, `compact-countdown` and `burn-rate` on the first line,
`project`, `git-branch`, `git-changes`, `lines-changed`, `today-spend` and
`vim-mode` on the second. The rest ship ready to use but render only if you
put them in a [custom layout](#custom-layout).

A widget renders nothing at all when its data is missing — no branch outside a
git repo, no `vim-mode` unless vim mode is on — and the bar closes up around it
rather than showing a blank segment.

| Widget | Description |
|--------|-------------|
| `model` | Current Claude model name and version |
| `session-cost` | Session cost in USD (color alerts at thresholds) |
| `today-spend` | Total daily cost across all sessions |
| `context-percent` | Context window usage with progress bar |
| `burn-rate` | Session spend rate in USD/hour |
| `cache-hit-rate` | Prompt cache hit percentage (`Hit: 99%`) |
| `token-breakdown` | Session input and output counts in one segment (`In:396 Out:137.8k`) |
| `compact-countdown` | Tokens remaining before auto-compact ([see note](#about-the-auto-compact-countdown)) |
| `git-branch` | Current git branch |
| `git-changes` | Staged/unstaged file counts |
| `lines-changed` | Lines added/removed in session |
| `api-latency` | Cumulative API wait time across the whole session (`API total: 8m 26s`) — not a single request's latency |
| `session-timer` | Time since the Claude Code process started (`Up: 1hr 46m`); resets when the session is resumed |
| `turn-counter` | Number of prompts you've sent this session (`#9`) — derived from the transcript, so it doesn't drift with render count |
| `block-timer` | Time elapsed in the current 5-hour usage block (`Block: 2hr 13m`) |
| `vim-mode` | Current vim mode (NORMAL/INSERT) |
| `custom-command` | Run a shell command and display output |
| `custom-text` | Static text |
| `separator` | Pipe separator (non-powerline mode) |
| `tokens-input` | Session input token count, uncached input only (`In: 396`) |
| `tokens-output` | Session output token count (`Out: 137.8k`) |
| `tokens-cached` | Cached token count (`Cached: 5.24M`) |
| `per-model` | Cost breakdown by model (`Sonnet 4.5:$3.40`) |
| `session-clock` | Time since the session began (`Session: 2hr 13m`); measured from the transcript, so it survives a resume |
| `cwd` | Current working directory |
| `project` | Project name (repo root), from `workspace.project_dir` |

### About the auto-compact countdown

`compact-countdown` and `context-percent` both predict the same event: Claude
Code's auto-compact. It fires once the context reaches **`window size − 33,000`
tokens** — a fixed reserve (20,000 tokens of output headroom plus a 13,000-token
compaction reserve), not a percentage of the window.

| Window | Compacts at | As a percentage |
|--------|------------:|----------------:|
| 200k | 167,000 | 83.5% |
| 1M | 967,000 | 96.7% |

Both widgets turn amber 20,000 tokens before that point — Claude Code's own
internal warning level — and red 5,000 tokens before it, so the two segments
change together.

Those bands widen when the token count they are measuring is itself coarse.
Claude Code rounds `used_percentage` to a whole number, so on a payload with no
exact `current_usage` breakdown the count moves in steps of one percent of the
window — 10,000 tokens at 1M, twice the width of the 5,000-token red band. A
band narrower than its own input's step can never be landed in, so each band is
held to at least one step wide, with amber kept at least one step above red.
With an exact breakdown the step is a single token and the bands are exactly
20,000 and 5,000 as above.

The rule is derived from Claude Code 2.1.220 rather than reported by it, so it
can drift when Claude Code changes. Two Claude Code settings also change the
answer and are invisible to a statusline command, so the prediction will be
wrong if you use them:

- `autoCompactWindow` (or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment
  variable) shrinks the window, so compaction fires earlier than shown.
- `autoCompactEnabled: false` disables compaction entirely, so it never fires.

### Widget options

Every widget supports:

| Option | Type | Description |
|--------|------|-------------|
| `type` | string | Widget type (required) |
| `fg` | string | Foreground color (hex, or a named color — see below) |
| `bg` | string | Background color (hex, or a named color — see below) |
| `label` | string | Custom label prefix |
| `priority` | number | Compact mode priority (lower = kept first) |

Some options apply only to particular widgets:

| Option | Widgets | Description |
|--------|---------|-------------|
| `text` | `custom-text` | The literal text to display; the widget renders nothing without it |
| `command` | `custom-command` | Shell command to run; the widget renders nothing without it |
| `separator` | `separator` | Separator string (default `" \| "`) |
| `icon` | `model`, `git-branch` | Prefix glyph; empty by default, since the usual choices need a Nerd Font |
| `cacheTtlMs` | `custom-command` | How long to reuse the command's output, in milliseconds (default `30000`) |

One rough edge worth knowing before you meet it: `format` is accepted by the
config schema but no widget reads it, so setting it does nothing.

`cacheTtlMs` was called `maxWidth` until
[issue #97](https://github.com/gapietro/gccusage/issues/97) — a width's name
for a duration, and the JSON Schema duly described it as a width, so
`maxWidth: 20` set a **20 millisecond** TTL and re-ran the shell command on
every render. The field is gone; if your config still sets it, it is ignored
and you get the 30s default. Rename it to `cacheTtlMs` to keep a custom TTL.

`fg`/`bg` accept a hex color (`"#ff0000"` or the 3-digit `"#f00"`) or one of
these named colors: `red`, `green`, `blue`, `yellow`, `cyan`, `magenta`,
`white`, `black`, `gray` (and `grey`), `orange`, `pink`.

Anything else is rejected when the config loads, and gccusage renders a single
error line naming the offending field instead of the statusline. This is
stricter than it looks: `"#12345"` (a typo) and `"196"` (an ansi256 code) are
errors, not colors. ansi256 codes are not supported — see
[issue #42](https://github.com/gapietro/gccusage/issues/42).

This applies to any config load failure, not just colors — malformed JSON, a
wrong type (`"enabled": "yes"`), or an unknown field value anywhere in the
file all replace the statusline with the same kind of error line, rather than
silently falling back to defaults. It looks like this:

```
⚠ gccusage config  ~/.config/gccusage/settings.json — lines.0.widgets.0.bg: must be a color name or #rgb/#rrggbb hex (got "196")
```

### Custom command widget

```json
{
  "type": "custom-command",
  "command": "date +%H:%M",
  "label": "Time:",
  "fg": "#ffffff",
  "bg": "#555555"
}
```

Commands are cached for 30s by default with a 2s execution timeout. Set
`cacheTtlMs` to change the cache TTL in milliseconds.

## Troubleshooting

**No colors showing**: gccusage forces truecolor output (chalk level 3) since Claude Code supports ANSI. If colors still don't appear, check your terminal emulator settings.

**Square boxes instead of separators**: The default separator `▶` (U+25B6) works in most terminals. If you see boxes, your font may not support it. Try a different separator:

```json
{
  "powerline": { "separator": ">", "separatorThin": "|" }
}
```

**Costs showing $0.00**: Ensure Claude Code is piping the status JSON correctly. The `cost.total_cost_usd` field must be present in stdin.

**Cache issues**: Delete `~/.cache/gccusage/statusline-cache.json` to force a fresh render.

## Development

```bash
npm test                   # Run the test suite
npm run test:watch         # Watch mode
npm run lint               # Lint src/ and scripts/ with oxlint
npm run build              # Build dist/index.js
npm run typecheck          # Type check src/
npm run typecheck:scripts  # Type check scripts/
npm run schema             # Regenerate config-schema.json from the code
npm run pricing            # Refresh the offline pricing snapshot from LiteLLM
npm run dev                # Run from source (requires Bun)
```

Lint rules live in `.oxlintrc.json`, which records why each choice was made.
It runs the `correctness` and `suspicious` tiers only, and there is no
formatter — style here is held by review, not by a tool that would rewrite
every file. Suppressions must be live: an `oxlint-disable` comment that no
longer suppresses anything is an error, not a warning, so it cannot outlive
the rule it was written for.

`dist/index.js` is committed, not built on clone: `gccusage setup` points
Claude Code straight at that file, so anyone upgrading with `git pull` runs it
without ever building. Rebuild and stage it in the same commit as any `src/`
change, or the change reaches nobody.

The tool itself and the `scripts/` tooling share one floor: Node 22. The files
under `scripts/` are TypeScript run directly by Node, so those specifically
need 22.18+, the release where type stripping runs unflagged; the tests that
spawn them skip themselves on older versions rather than failing.

## Uninstall

1. Remove the `statusLine` key from `~/.claude/settings.json`
2. `npm unlink -g gccusage` (or delete the cloned repo)
3. Optionally delete config and cache: `rm -rf ~/.config/gccusage ~/.cache/gccusage`

## License

MIT
