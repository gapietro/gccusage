import type { Settings } from "./schema.js";

export const DEFAULT_SETTINGS: Settings = {
  lines: [
    {
      widgets: [
        { type: "model" },
        { type: "separator" },
        { type: "session-cost" },
        { type: "separator" },
        { type: "context-percent" },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "block-timer" },
        { type: "separator" },
        { type: "today-spend" },
        { type: "separator" },
        { type: "burn-rate" },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "git-branch" },
        { type: "separator" },
        { type: "git-changes" },
      ],
      flex: "left",
    },
  ],
  powerline: {
    enabled: false,
    theme: "default",
    separator: "\uE0B0",
    separatorThin: "\uE0B1",
  },
  cache: {
    statuslineTtlMs: 5000,
    pricingTtlMs: 86400000,
  },
  costSource: "auto",
};
