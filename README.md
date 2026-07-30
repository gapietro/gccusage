# gccusage

A powerline-style statusline for [Claude Code](https://claude.com/claude-code). Displays model info, costs, context usage, git status, and more in a compact, color-coded terminal bar.

```
 Opus 4.6 ▶ $14.21 ▶ [========--] 82% (200.0k) ▶ ~3.0k left ▶ 11.6k tok/m ▶
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

Automatically collapses to a single line on narrow terminals:

```json
{
  "compact": {
    "mode": "auto",
    "threshold": 80
  }
}
```

Modes: `auto` (collapse below threshold), `always`, `never`

## Widgets

| Widget | Description |
|--------|-------------|
| `model` | Current Claude model name and version |
| `session-cost` | Session cost in USD (color alerts at thresholds) |
| `today-spend` | Total daily cost across all sessions |
| `context-percent` | Context window usage with progress bar |
| `burn-rate` | Token consumption rate (tok/min) |
| `cache-hit-rate` | Prompt cache hit percentage |
| `token-breakdown` | Input vs output token counts |
| `compact-countdown` | Estimated tokens remaining before auto-compact ([see note](#about-the-auto-compact-estimate)) |
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

### About the auto-compact estimate

`compact-countdown` assumes auto-compact fires once **83.5%** of the context
window is consumed — a 16.5% buffer. That figure is an estimate of Claude Code's
internal behavior, not a value it reports, and it has not been verified against a
measured session. It may also differ between 200k and 1M context windows.

Treat the number as a guide, not a guarantee: if the buffer is larger than 16.5%
the widget warns late, and if smaller it warns early. Note that
`context-percent`'s own red threshold sits at 90%, which is above this estimate —
so under the current model a session compacts before that red state is reached.

### Widget options

Every widget supports:

| Option | Type | Description |
|--------|------|-------------|
| `type` | string | Widget type (required) |
| `fg` | string | Foreground color (hex) |
| `bg` | string | Background color (hex) |
| `label` | string | Custom label prefix |
| `priority` | number | Compact mode priority (lower = kept first) |

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
