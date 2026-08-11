import chalk from "chalk";

// Palette follows opencode's own token structure (near-black base, layered
// panel/element/border steps) — ported from its default theme
// (packages/tui/src/theme/assets/opencode.json upstream), re-tinted toward
// our purple/pink brand instead of opencode's orange/blue.
export const THEME = {
  primary: "#E899F2",
  secondary: "#9D7CD8",
  accent: "#8B5CF6",
  dim: "#5C5470",

  background: "#0A0A0A",
  backgroundPanel: "#141414",
  backgroundElement: "#1E1E1E",
  border: "#3C3C3C",
  borderActive: "#6B5B95",

  text: {
    primary: "#EEEEEE",
    secondary: "#B8A8D9",
    dim: "#808080",
    error: "#E06C75",
    success: "#7FD88F",
    warning: "#F5A742",
  },

  diff: {
    added: "#4FD6BE",
    removed: "#C53B53",
    addedBg: "#20303B",
    removedBg: "#37222C",
  },

  ui: {
    border: "#3C3C3C",
    header: "#E899F2",
    footer: "#9D7CD8",
    input: "#EEEEEE",
    thinking: "#B8A8D9",
  }
};

function hexToRgb(c) {
  const n = c.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

function rgbToHex([r, g, b]) {
  const toHex = (n) => Math.round(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Samples `count` colors evenly across a multi-stop gradient (`stops`, hex
// strings, first→last). Used to color the sparkle logo per-row and the
// "UPSTAGE" wordmark per-letter.
export function gradientColors(stops, count) {
  if (count <= 1) return [stops[0]];
  const segments = stops.length - 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * segments;
    const seg = Math.min(Math.floor(t), segments - 1);
    const localT = t - seg;
    const a = hexToRgb(stops[seg]);
    const b = hexToRgb(stops[seg + 1]);
    out.push(rgbToHex(a.map((v, idx) => v + (b[idx] - v) * localT)));
  }
  return out;
}

export const COLOR = {
  primary: THEME.primary,
  secondary: THEME.secondary,
  accent: THEME.accent,

  text: {
    primary: THEME.text.primary,
    secondary: THEME.text.secondary,
    dim: THEME.text.dim,
    bold: "\x1b[1m",
    italic: "\x1b[3m"
  },

  status: {
    success: "\x1b[32m",
    warning: "\x1b[33m",
    error: "\x1b[31m",
    info: "\x1b[36m"
  },

  diff: {
    added: "\x1b[48;2;32;48;59m",
    removed: "\x1b[48;2;55;34;44m"
  }
};

export function c(color, value) {
  if (typeof color === "string" && color.startsWith("#")) {
    return chalk.hex(color)(value);
  }
  return `${color}${value}\x1b[0m`;
}
