export const DEFAULT_LOOP_BUDGET = {
  maxSteps: 12,
  maxToolCalls: 30,
  maxWallTimeMs: 180_000,
  // Cost guardrail (docs/feature-landscape-2026.md §2.2) — separate from
  // the context-window/token-budget warning above: this caps actual USD
  // spend per turn, a real gap since the existing tokenBudgeter only ever
  // warned at 80% context usage, never stopped anything. Override via
  // settings.maxCostUsd (same cascade as everything else in settings.mjs).
  maxCostUsd: 5.0
};

export const DEFAULT_POLICY = {
  allowHighRiskTools: false,
  requireConfirmationForHighRisk: true
};
