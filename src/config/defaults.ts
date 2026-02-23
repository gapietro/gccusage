import type { Settings } from "./schema.js";

export const DEFAULT_SETTINGS: Settings = {
  lines: [
    {
      widgets: [
        { type: "model" },
        { type: "session-cost" },
        { type: "context-percent" },
        { type: "burn-rate" },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "git-branch" },
        { type: "git-changes" },
        { type: "today-spend" },
        { type: "block-timer" },
      ],
      flex: "left",
    },
  ],
  powerline: {
    enabled: true,
    theme: "default",
    separator: "\u25B6",
    separatorThin: "\u2502",
  },
  cache: {
    statuslineTtlMs: 5000,
    pricingTtlMs: 86400000,
  },
  costSource: "auto",
};
