# gccusage

A powerline-style statusline for [Claude Code](https://claude.com/claude-code). Displays model info, costs, context usage, git status, and more in a compact, color-coded terminal bar.

```
 Opus 4.6 ▶ $14.21 ▶ [========--] 82% (200.0k) ▶ 11.6k tok/m ▶ Cache: 99% ▶
 main ▶ +307 -43 ▶ Today: $14.50 ▶ API: 9m 55s ▶
```

## Quick Start

```bash
git clone https://github.com/gapietro/gccusage.git
cd gccusage && npm link
gccusage setup
```

That's it — restart Claude Code and you'll see the statusline.

### Alternative: global install from GitHub

```bash
npm install -g github:gapietro/gccusage
gccusage setup
```

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
| `compact-countdown` | Estimated tokens remaining before auto-compact |
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

## License

MIT
