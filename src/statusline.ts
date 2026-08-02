import { buildRenderContext } from "./data/pipeline.js";
import { renderStatusline } from "./render/renderer.js";
import { checkCache, writeCache } from "./cache/cache-manager.js";
import { computeCacheKey } from "./cache/cache-key.js";
import { getTerminalWidth } from "./utils/terminal.js";
import type { Settings } from "./config/schema.js";
import type { StatusJson } from "./types/status-json.js";

export async function runStatusline(
  stdin: StatusJson,
  settings: Settings,
): Promise<string> {
  const terminalWidth = getTerminalWidth();

  // Check cache first (hot path). The key is a hash of the whole stdin
  // payload (minus the two wall-clock counters) plus the terminal width, so
  // it carries the properties the old (sessionId, costUsd, terminalWidth)
  // triple was built for and the ones it missed (#96):
  //   - a changed cumulative cost misses, so the pipeline re-runs and
  //     trackDailyCost records the new spend (issue #30);
  //   - a resize misses, since layout depends on width and a bar laid out
  //     for the old width is wrong output, not just stale (PR #71);
  //   - and so does any other render input — vim mode, model, context
  //     percentage, project directory — which the triple served stale.
  const key = computeCacheKey(stdin, terminalWidth);
  const cached = checkCache(settings.cache?.statuslineTtlMs ?? 5000, key);
  if (cached !== null) {
    return cached;
  }

  const context = await buildRenderContext(stdin, settings);
  const output = renderStatusline(context, settings);

  writeCache(output, key);
  return output;
}
