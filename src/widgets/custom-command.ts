import { execSync } from "node:child_process";
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

interface CacheEntry {
  output: string;
  timestamp: number;
}

// In-memory cache keyed by command string
const commandCache = new Map<string, CacheEntry>();

/** Exported so the published JSON Schema documents the real default (#97). */
export const DEFAULT_TTL_MS = 30000; // 30 seconds
const DEFAULT_TIMEOUT_MS = 2000; // 2 second execution timeout

export const customCommandWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const command = config.command;
    if (!command) return null;

    const ttl = config.cacheTtlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();

    // Check cache
    const cached = commandCache.get(command);
    if (cached && now - cached.timestamp < ttl) {
      const label = config.label;
      const text = label ? `${label} ${cached.output}` : cached.output;
      return { text, fg: config.fg, bg: config.bg };
    }

    try {
      const raw = execSync(command, {
        encoding: "utf-8",
        timeout: DEFAULT_TIMEOUT_MS,
        cwd: context.stdin.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (!raw) return null;

      // Take only first line
      const output = raw.split("\n")[0] ?? "";
      commandCache.set(command, { output, timestamp: now });

      const label = config.label;
      const text = label ? `${label} ${output}` : output;
      return { text, fg: config.fg, bg: config.bg };
    } catch {
      // Return stale cache on error if available
      if (cached) {
        const label = config.label;
        const text = label ? `${label} ${cached.output}` : cached.output;
        return { text, fg: config.fg, bg: config.bg };
      }
      return null;
    }
  },
};
