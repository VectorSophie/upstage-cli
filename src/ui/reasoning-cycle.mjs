/**
 * Reasoning-effort cycling for the TUI — Solar Pro2's own hybrid reasoning
 * switch (see Upstage's Solar Pro2 Prompting Handbook), not something
 * borrowed from another agent. "auto" omits the API field entirely and
 * lets the model pick; "low"/"high" force it. Mirrors mode-cycle.mjs's
 * shape exactly (same rotate/label/color triplet) since it's the same
 * cycle-a-chip UX as permission mode.
 */
import { THEME } from "./colors.mjs";

export const REASONING_EFFORTS = ["auto", "low", "high"];

export function nextReasoningEffort(current) {
  const i = REASONING_EFFORTS.indexOf(current);
  return REASONING_EFFORTS[(i + 1) % REASONING_EFFORTS.length];
}

export function reasoningEffortLabel(effort) {
  switch (effort) {
    case "low": return "reason:low";
    case "high": return "reason:high";
    default: return "reason:auto";
  }
}

export function reasoningEffortColor(effort) {
  switch (effort) {
    case "high": return THEME.accent;
    case "low": return THEME.text.dim;
    default: return THEME.secondary;
  }
}
