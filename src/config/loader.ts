import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { SettingsSchema, type Settings } from "./schema.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

function getConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return path.join(xdg, "gccusage");
  return path.join(process.env["HOME"] || "~", ".config", "gccusage");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "settings.json");
}

/** Shallow-merge only keys that exist in the source object. */
function mergeIfPresent<T extends Record<string, unknown>>(
  defaults: T,
  raw: Record<string, unknown> | undefined,
  validated: Partial<T> | undefined,
): T {
  if (!raw || !validated) return defaults;
  const result = { ...defaults };
  for (const key of Object.keys(raw)) {
    if (key in validated) {
      (result as Record<string, unknown>)[key] = (validated as Record<string, unknown>)[key];
    }
  }
  return result;
}

/** Deep-merge user overrides onto defaults, only overriding keys the user actually set. */
function mergeSettings(
  defaults: Settings,
  raw: Record<string, unknown>,
  validated: v.InferOutput<typeof SettingsSchema>,
): Settings {
  return {
    lines: validated.lines ?? defaults.lines,
    powerline: mergeIfPresent(
      defaults.powerline,
      raw["powerline"] as Record<string, unknown> | undefined,
      validated.powerline,
    ),
    compact: mergeIfPresent(
      defaults.compact,
      raw["compact"] as Record<string, unknown> | undefined,
      validated.compact,
    ),
    alerts: mergeIfPresent(
      defaults.alerts,
      raw["alerts"] as Record<string, unknown> | undefined,
      validated.alerts,
    ),
    cache: mergeIfPresent(
      defaults.cache,
      raw["cache"] as Record<string, unknown> | undefined,
      validated.cache,
    ),
    costSource: "costSource" in raw ? (validated.costSource ?? defaults.costSource) : defaults.costSource,
  };
}

export interface ConfigLoad {
  settings: Settings;
  /**
   * Present when a config file existed but could not be used. An absent file
   * is not an error — having no config is the normal case.
   */
  error?: string;
}

/** One line describing why the config file was rejected. */
function describeIssues(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]): string {
  const [first, ...rest] = issues;
  const dotPath = v.getDotPath(first);
  const where = dotPath ? `${dotPath}: ` : "";
  const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
  // `first.received` is already quoted by valibot ("196" comes back as the
  // 5-character string `"196"`), so it is interpolated bare.
  return `${where}${first.message} (got ${first.received})${more}`;
}

export function loadSettings(): ConfigLoad {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { settings: DEFAULT_SETTINGS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      settings: DEFAULT_SETTINGS,
      error: err instanceof SyntaxError ? `invalid JSON: ${detail}` : `cannot read config: ${detail}`,
    };
  }

  const result = v.safeParse(SettingsSchema, parsed);
  if (!result.success) {
    return { settings: DEFAULT_SETTINGS, error: describeIssues(result.issues) };
  }

  return {
    settings: mergeSettings(DEFAULT_SETTINGS, parsed as Record<string, unknown>, result.output),
  };
}
