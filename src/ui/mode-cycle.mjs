/**
 * Permission-mode cycling for the TUI (shift+tab), matching Claude Code's
 * default → accept-edits → plan rotation, plus presentation helpers.
 */
import { THEME } from "./colors.mjs";

export const CYCLE_MODES = ["default", "acceptEdits", "plan"];

export function nextMode(current) {
  const i = CYCLE_MODES.indexOf(current);
  return CYCLE_MODES[(i + 1) % CYCLE_MODES.length];
}

export function modeLabel(mode) {
  switch (mode) {
    case "acceptEdits": return "accept edits";
    case "plan": return "plan";
    case "auto": return "auto";
    case "bypassPermissions": return "bypass";
    default: return "default";
  }
}

export function modeColor(mode) {
  switch (mode) {
    case "plan": return THEME.accent;
    case "acceptEdits": return THEME.text.success;
    case "auto": return THEME.secondary;
    case "bypassPermissions": return THEME.text.warning;
    default: return THEME.dim;
  }
}
