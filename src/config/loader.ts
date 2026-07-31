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

/** Cap on each unbounded fragment of an error line, in characters. */
const MAX_FRAGMENT_LENGTH = 120;

/**
 * Cap one fragment of the error line. Applied per fragment rather than to the
 * finished line so the structure around it — the dot path, the `(+N more)`
 * count — always survives, whatever the config file contains.
 */
function truncate(text: string): string {
  if (text.length <= MAX_FRAGMENT_LENGTH) return text;
  return `${text.slice(0, MAX_FRAGMENT_LENGTH)}…`;
}

/** One line describing why the config file was rejected. */
function describeIssues(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]): string {
  const [first, ...rest] = issues;
  const dotPath = v.getDotPath(first);
  const where = dotPath ? `${dotPath}: ` : "";
  const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
  // valibot's own type-mismatch ("schema" kind) messages already embed the
  // received value (e.g. "Invalid type: Expected Array but received \"nope\"").
  // Only `v.check` failures ("validation" kind) have a message that doesn't
  // mention the value, so only those need the explicit `(got …)` suffix.
  // `first.received` is already quoted by valibot ("196" comes back as the
  // 5-character string `"196"`), so it is interpolated bare, just capped.
  const suffix = first.kind === "validation" ? ` (got ${truncate(first.received)})` : "";
  // The message needs the same cap: a "schema" kind message embeds the received
  // value itself, so a 10 KB string in a mistyped field would otherwise emit a
  // 10 KB statusline. (JSON.parse errors need no cap — Node truncates its own
  // snippet — so the two paths below are already bounded.)
  return `${where}${truncate(first.message)}${suffix}${more}`;
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
