import { getWidgetTypes } from "../widgets/registry.js";
import { THEMES } from "../render/themes.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { FLEX_MODES, COMPACT_MODES, COST_SOURCES } from "./schema.js";

/**
 * Builds the published JSON Schema for user settings (`config-schema.json`).
 *
 * Every closed list and every default here is read from the code that owns it
 * — widget types from the registry, theme names from THEMES, the option lists
 * from the same arrays valibot validates against, defaults from
 * DEFAULT_SETTINGS. Nothing is restated. That is the whole point: the file
 * had drifted to 17 of 26 widget types, no `compact`/`alerts` sections and
 * three wrong powerline defaults precisely because it was maintained by hand
 * with nothing tying it to the code (#75).
 *
 * Defaults come from DEFAULT_SETTINGS rather than the valibot fallbacks
 * because user config is merged onto DEFAULT_SETTINGS by the loader — so
 * DEFAULT_SETTINGS is what a user actually gets when they omit a key, and the
 * valibot fallback only applies to a partial section.
 *
 * `src/__tests__/config-schema.test.ts` fails when the committed file and
 * this function disagree; `npm run schema` rewrites the file.
 */
export function buildConfigJsonSchema(): Record<string, unknown> {
  const { powerline, compact, alerts, cache, costSource } = DEFAULT_SETTINGS;

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "gccusage settings",
    description: "Configuration for gccusage Claude Code statusline tool",
    type: "object",
    properties: {
      lines: {
        type: "array",
        description: "Status lines to render",
        items: {
          type: "object",
          properties: {
            widgets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    // Generated from the registry, so a newly registered
                    // widget is valid here the moment it exists.
                    enum: getWidgetTypes(),
                    description: "Widget type",
                  },
                  label: { type: "string", description: "Optional label prefix" },
                  fg: {
                    type: "string",
                    description:
                      "Foreground color: a named color or #rgb/#rrggbb hex (ansi256 is not supported — see issue #42)",
                  },
                  bg: {
                    type: "string",
                    description:
                      "Background color: a named color or #rgb/#rrggbb hex (ansi256 is not supported — see issue #42)",
                  },
                  icon: { type: "string", description: "Icon prefix" },
                  format: { type: "string", description: "Custom format string" },
                  command: { type: "string", description: "Shell command (custom-command widget)" },
                  text: { type: "string", description: "Static text (custom-text widget)" },
                  separator: { type: "string", description: "Separator string (separator widget)" },
                  maxWidth: { type: "number", description: "Maximum width for this widget" },
                  priority: {
                    type: "number",
                    description:
                      "Compaction priority — LOWER survives longer. renderCompact sorts ascending and keeps widgets until the terminal width runs out; widgets without a priority sort last.",
                  },
                },
                required: ["type"],
              },
            },
            flex: {
              type: "string",
              enum: [...FLEX_MODES],
              default: "left",
              description: "Flex alignment mode for the line",
            },
          },
          required: ["widgets"],
        },
      },
      powerline: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: powerline.enabled },
          theme: {
            type: "string",
            // Stricter than the validator on purpose: valibot accepts any
            // string and getTheme() silently falls back to "default", which
            // is exactly the typo an editor should catch.
            enum: Object.keys(THEMES),
            default: powerline.theme,
          },
          separator: { type: "string", default: powerline.separator },
          separatorThin: {
            type: "string",
            default: powerline.separatorThin,
            description:
              "Drawn instead of the main separator between segments whose backgrounds are too close to tell apart (issues #36, #40)",
          },
        },
      },
      compact: {
        type: "object",
        description: "How the bar behaves when it does not fit the terminal",
        properties: {
          mode: {
            type: "string",
            enum: [...COMPACT_MODES],
            default: compact.mode,
            description:
              "auto compacts only when the rendered bar exceeds threshold and the terminal width is known",
          },
          threshold: {
            type: "number",
            default: compact.threshold,
            description: "Width in columns below which auto mode compacts",
          },
        },
      },
      alerts: {
        type: "object",
        description: "Dollar thresholds at which cost widgets repaint amber, then red",
        properties: {
          sessionWarn: { type: "number", default: alerts.sessionWarn },
          sessionDanger: { type: "number", default: alerts.sessionDanger },
          dailyWarn: { type: "number", default: alerts.dailyWarn },
          dailyDanger: { type: "number", default: alerts.dailyDanger },
        },
      },
      cache: {
        type: "object",
        properties: {
          statuslineTtlMs: {
            type: "number",
            default: cache.statuslineTtlMs,
            description: "Statusline cache TTL in ms",
          },
          pricingTtlMs: {
            type: "number",
            default: cache.pricingTtlMs,
            description: "Pricing cache TTL in ms (default 24h)",
          },
        },
      },
      costSource: {
        type: "string",
        enum: [...COST_SOURCES],
        default: costSource,
        description: "How to determine session cost",
      },
    },
  };
}
