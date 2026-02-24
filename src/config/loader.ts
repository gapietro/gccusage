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
      defaults.powerline ?? {},
      raw["powerline"] as Record<string, unknown> | undefined,
      validated.powerline,
    ),
    compact: mergeIfPresent(
      defaults.compact ?? {},
      raw["compact"] as Record<string, unknown> | undefined,
      validated.compact,
    ),
    cache: mergeIfPresent(
      defaults.cache ?? {},
      raw["cache"] as Record<string, unknown> | undefined,
      validated.cache,
    ),
    costSource: "costSource" in raw ? (validated.costSource ?? defaults.costSource) : defaults.costSource,
  };
}

export function loadSettings(): Settings {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return DEFAULT_SETTINGS;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = v.parse(SettingsSchema, parsed);
    return mergeSettings(DEFAULT_SETTINGS, parsed, validated);
  } catch {
    return DEFAULT_SETTINGS;
  }
}
