import * as v from "valibot";

const ColorSchema = v.union([
  v.string(), // named color, hex, or ansi256
]);

const WidgetConfigSchema = v.object({
  type: v.string(),
  label: v.optional(v.string()),
  fg: v.optional(ColorSchema),
  bg: v.optional(ColorSchema),
  icon: v.optional(v.string()),
  format: v.optional(v.string()),
  command: v.optional(v.string()),
  text: v.optional(v.string()),
  separator: v.optional(v.string()),
  maxWidth: v.optional(v.number()),
  priority: v.optional(v.number()),
});

export type WidgetConfig = v.InferOutput<typeof WidgetConfigSchema>;

const LineConfigSchema = v.object({
  widgets: v.array(WidgetConfigSchema),
  flex: v.optional(v.picklist(["left", "right", "center", "space-between"]), "left"),
});

export type LineConfig = v.InferOutput<typeof LineConfigSchema>;

const PowerlineConfigSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  theme: v.optional(v.string(), "default"),
  separator: v.optional(v.string(), "\uE0B0"),
  separatorThin: v.optional(v.string(), "\uE0B1"),
});

const CacheConfigSchema = v.object({
  statuslineTtlMs: v.optional(v.number(), 5000),
  pricingTtlMs: v.optional(v.number(), 86400000),
});

const CompactConfigSchema = v.object({
  mode: v.optional(v.picklist(["auto", "always", "never"]), "auto"),
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
  costSource: v.optional(v.picklist(["auto", "calculated", "stdin"]), "auto"),
});

/** Raw parsed settings (lines may be missing if user only overrides powerline/cache). */
export type PartialSettings = v.InferOutput<typeof SettingsSchema>;

/** Fully resolved settings after merging with defaults — all sections present. */
export type Settings = Required<PartialSettings>;
