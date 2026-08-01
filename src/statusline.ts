import { buildRenderContext } from "./data/pipeline.js";
import { renderStatusline } from "./render/renderer.js";
import { checkCache, writeCache } from "./cache/cache-manager.js";
import { getTerminalWidth } from "./utils/terminal.js";
import type { Settings } from "./config/schema.js";
import type { StatusJson } from "./types/status-json.js";

export async function runStatusline(
  stdin: StatusJson,
  settings: Settings,
): Promise<string> {
  const sessionId = stdin.session_id;
  const stdinCost = stdin.cost?.total_cost_usd;
  const terminalWidth = getTerminalWidth();

  // Check cache first (hot path). The stdin cost is part of the cache key:
  // a changed cumulative cost bypasses the cache so the pipeline re-runs and
  // trackDailyCost records the new spend (issue #30). While the cost is
  // unchanged, serving the cache is safe — the tracker already saw this
  // value on the last miss. The terminal width is also part of the key:
  // layout (e.g. compact.mode: "auto") depends on width, so a resize between
  // spawns must bypass the cache too — otherwise a bar laid out for the old
  // width would be served, wrong, until the TTL expires or the cost changes.
  const cached = checkCache(
    settings.cache?.statuslineTtlMs ?? 5000,
    sessionId,
    stdinCost,
    terminalWidth,
  );
  if (cached !== null) {
    return cached;
  }

  const context = await buildRenderContext(stdin, settings);
  const output = renderStatusline(context, settings);

  writeCache(output, sessionId, stdinCost, terminalWidth);
  return output;
}
