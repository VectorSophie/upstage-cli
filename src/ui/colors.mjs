import chalk from "chalk";

export const THEME = {
  primary: "#E899F2",
  secondary: "#8596F2",
  accent: "#3D6AF2",
  dim: "#ACBEF2",
  
  text: {
    primary: "#FFFFFF",
    secondary: "#ACBEF2",
    dim: "#7C8DB2",
    error: "#FF5555",
    success: "#50FA7B",
    warning: "#FFB86C",
  },

  ui: {
    border: "#3D6AF2",
    header: "#E899F2",
    footer: "#8596F2",
    input: "#FFFFFF",
    thinking: "#ACBEF2",
  }
};

export const COLOR = {
  primary: THEME.primary,
  secondary: THEME.secondary,
  accent: THEME.accent,
  
  text: {
    primary: "#FFFFFF",
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
    added: "\x1b[48;2;12;44;12m",
    removed: "\x1b[48;2;44;12;12m"
  }
};

export function c(color, value) {
  if (typeof color === "string" && color.startsWith("#")) {
    return chalk.hex(color)(value);
  }
  return `${color}${value}\x1b[0m`;
}
