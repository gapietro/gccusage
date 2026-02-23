export interface PowerlineTheme {
  name: string;
  segments: SegmentStyle[];
}

export interface SegmentStyle {
  fg: string;
  bg: string;
}

export const THEMES: Record<string, PowerlineTheme> = {
  default: {
    name: "default",
    segments: [
      { fg: "#ffffff", bg: "#5f5faf" },
      { fg: "#ffffff", bg: "#444444" },
      { fg: "#ffffff", bg: "#262626" },
      { fg: "#aaaaaa", bg: "#1c1c1c" },
    ],
  },
  ocean: {
    name: "ocean",
    segments: [
      { fg: "#ffffff", bg: "#005f87" },
      { fg: "#ffffff", bg: "#00445f" },
      { fg: "#afd7ff", bg: "#003040" },
      { fg: "#87afd7", bg: "#002030" },
    ],
  },
  forest: {
    name: "forest",
    segments: [
      { fg: "#ffffff", bg: "#2d5016" },
      { fg: "#ffffff", bg: "#1e3a0e" },
      { fg: "#a8d870", bg: "#152a08" },
      { fg: "#6aaf30", bg: "#0c1c04" },
    ],
  },
  sunset: {
    name: "sunset",
    segments: [
      { fg: "#ffffff", bg: "#af5f00" },
      { fg: "#ffffff", bg: "#874700" },
      { fg: "#ffd787", bg: "#5f3400" },
      { fg: "#d7af5f", bg: "#3e2200" },
    ],
  },
  minimal: {
    name: "minimal",
    segments: [
      { fg: "#d0d0d0", bg: "#333333" },
      { fg: "#aaaaaa", bg: "#262626" },
      { fg: "#888888", bg: "#1c1c1c" },
      { fg: "#666666", bg: "#141414" },
    ],
  },
};

export function getTheme(name: string): PowerlineTheme {
  return THEMES[name] ?? THEMES["default"]!;
}
