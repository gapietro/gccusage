import * as v from "valibot";
import { isValidColor } from "../render/colors.js";

// A widget color: a named color from NAMED_COLORS (src/render/colors.ts) or an
// anchored `#rgb`/`#rrggbb` hex. Anything else is a config load error rather
// than a render-time fallback — chalk's hex regex is unanchored, so values
// like "196" or "#12345" would otherwise paint an unrelated color instead of
// failing. ansi256 codes are deliberately unsupported (issue #42).
const ColorSchema = v.pipe(
  v.string(),
  v.check(isValidColor, "must be a color name or #rgb/#rrggbb hex"),
);

// Exported so the published JSON Schema can be checked against the exact set
// of options the validator accepts, rather than only against itself (#97).
export const WidgetConfigSchema = v.object({
  type: v.string(),
  label: v.optional(v.string()),
  fg: v.optional(ColorSchema),
  bg: v.optional(ColorSchema),
  icon: v.optional(v.string()),
  format: v.optional(v.string()),
  command: v.optional(v.string()),
  text: v.optional(v.string()),
  separator: v.optional(v.string()),
  // Read only by `custom-command`. It was called `maxWidth` until #97, which
  // is a width's name for a duration: the JSON Schema said "Maximum width for
  // this widget", so `maxWidth: 20` set a 20ms TTL and re-ran the shell
  // command on every render. No widget has ever implemented a width here.
  cacheTtlMs: v.optional(v.number()),
  priority: v.optional(v.number()),
});

export type WidgetConfig = v.InferOutput<typeof WidgetConfigSchema>;

// The closed option lists below are exported so the published JSON Schema can
// be generated from the same arrays valibot validates against, rather than
// restating them (#75). One array, two consumers: adding an option here
// reaches both.
export const FLEX_MODES = ["left", "right", "center", "space-between"] as const;
export const COMPACT_MODES = ["auto", "always", "never"] as const;
export const COST_SOURCES = ["auto", "calculated", "stdin"] as const;

const LineConfigSchema = v.object({
  widgets: v.array(WidgetConfigSchema),
  flex: v.optional(v.picklist(FLEX_MODES), "left"),
});

export type LineConfig = v.InferOutput<typeof LineConfigSchema>;

const PowerlineConfigSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  theme: v.optional(v.string(), "default"),
  separator: v.optional(v.string(), "\uE0B0"),
  separatorThin: v.optional(v.string(), "\u2502"),
});

const CacheConfigSchema = v.object({
  statuslineTtlMs: v.optional(v.number(), 5000),
  pricingTtlMs: v.optional(v.number(), 86400000),
});

const CompactConfigSchema = v.object({
  mode: v.optional(v.picklist(COMPACT_MODES), "auto"),
  threshold: v.optional(v.number(), 80),
});

const AlertsConfigSchema = v.object({
  sessionWarn: v.optional(v.number(), 5),
  sessionDanger: v.optional(v.number(), 15),
  dailyWarn: v.optional(v.number(), 10),
  dailyDanger: v.optional(v.number(), 25),
});

export const SettingsSchema = v.object({
  lines: v.optional(v.array(LineConfigSchema)),
  powerline: v.optional(PowerlineConfigSchema),
  compact: v.optional(CompactConfigSchema),
  alerts: v.optional(AlertsConfigSchema),
  cache: v.optional(CacheConfigSchema),
  costSource: v.optional(v.picklist(COST_SOURCES), "auto"),
});

/** Raw parsed settings (lines may be missing if user only overrides powerline/cache). */
export type PartialSettings = v.InferOutput<typeof SettingsSchema>;

/** Fully resolved settings after merging with defaults — all sections present. */
export type Settings = Required<PartialSettings>;
