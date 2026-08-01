# gccusage

A powerline-style statusline for [Claude Code](https://claude.com/claude-code). Displays model info, costs, context usage, git status, and more in a compact, color-coded terminal bar.

```
 Opus 4.6 ▶ $14.21 ▶ [========--] 82% (200.0k) ▶ ~3.0k left ▶ $4.20/hr ▶
 main ▶ +2 ~5 -1 ▶ +307 -43 ▶ Today: $14.50 ▶
```

## Prerequisites

- **Node.js 18+** — check with `node -v`
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

### Alternative: global install from GitHub

```bash
npm install -g github:gapietro/gccusage
gccusage setup
```

### Deploy to another machine

1. Install Node.js 18+ (e.g. `brew install node` on macOS)
2. Clone the repo: `git clone https://github.com/gapietro/gccusage.git`
3. `cd gccusage && npm install && npm link`
4. `gccusage setup`
5. Restart Claude Code

### What `gccusage setup` does

Adds the following to `~/.claude/settings.json` (creates the file if missing, preserves existing settings):

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

### Compact mode

Collapses both lines into a single line when the terminal is narrower than
`threshold` columns (default 80), keeping segments in `priority` order —
lower numbers survive. The terminal width comes from the `COLUMNS` variable
Claude Code sets when it runs the statusline; if it is unavailable, `auto`
never collapses the bar.

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

| Widget | Description |
|--------|-------------|
| `model` | Current Claude model name and version |
| `session-cost` | Session cost in USD (color alerts at thresholds) |
| `today-spend` | Total daily cost across all sessions |
| `context-percent` | Context window usage with progress bar |
| `burn-rate` | Session spend rate in USD/hour |
| `cache-hit-rate` | Prompt cache hit percentage |
| `token-breakdown` | Input vs output token counts |
| `compact-countdown` | Tokens remaining before auto-compact ([see note](#about-the-auto-compact-countdown)) |
| `git-branch` | Current git branch |
| `git-changes` | Staged/unstaged file counts |
| `lines-changed` | Lines added/removed in session |
| `api-latency` | Total API wait time |
| `session-timer` | Wall-clock session duration |
| `turn-counter` | Conversation turn count |
| `block-timer` | Time since last block event |
| `vim-mode` | Current vim mode (NORMAL/INSERT) |
| `custom-command` | Run a shell command and display output |
| `custom-text` | Static text |
| `separator` | Pipe separator (non-powerline mode) |
| `tokens-input` | Input token count |
| `tokens-output` | Output token count |
| `tokens-cached` | Cached token count |
| `per-model` | Cost breakdown by model |
| `session-clock` | Session start time |
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

Commands are cached for 30s by default with a 2s execution timeout.

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
npm run test          # Run tests
npm run test:watch    # Watch mode
npm run build         # Build dist/index.js
npm run typecheck     # Type check
```

## Uninstall

1. Remove the `statusLine` key from `~/.claude/settings.json`
2. `npm unlink -g gccusage` (or delete the cloned repo)
3. Optionally delete config and cache: `rm -rf ~/.config/gccusage ~/.cache/gccusage`

## License

MIT
