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

export function loadSettings(): Settings {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return DEFAULT_SETTINGS;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return v.parse(SettingsSchema, parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}
