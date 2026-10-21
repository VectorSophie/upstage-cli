import { failToPassRate, passToPassRate } from "./checks.mjs";

const DEFAULT_WEIGHTS = {
  checks: 0.60,
  patchMinimality: 0.15,
  toolCallCount: 0.10,
  costUsd: 0.10,
  speedMs: 0.05
};

const DEFAULT_COST_BUDGET = 1.0;

function clamp(v, min = 0, max = 1) {
  return Math.min(Math.max(v, min), max);
}

function log1p(x) {
  return Math.log(1 + x);
}

export function checksScore(failToPass, passToPass) {
  return (failToPass * 0.7) + (passToPass * 0.3);
}

export function patchMinimalityScore(linesAdded, linesRemoved) {
  const total = (linesAdded || 0) + (linesRemoved || 0);
  return 1 / (1 + log1p(total));
}

export function toolCallScore(toolCalls) {
  return 1 / (1 + log1p(toolCalls || 0));
}

export function costScore(costUsd, budgetUsd = DEFAULT_COST_BUDGET) {
  if (!budgetUsd || budgetUsd <= 0) return 1.0;
  return clamp(1 - costUsd / budgetUsd, 0, 1);
}

export function speedScore(durationMs, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return 1.0;
  return clamp(1 - durationMs / timeoutMs, 0, 1);
}

/**
 * Legacy composite score, kept for backward compatibility. It is NOT an
 * authoritative ranking — run status comes from determineOutcome() (checks.mjs).
 * Components whose input is unknown (e.g. cost without provider usage) are
 * reported as null and left out, with the remaining weights renormalised.
 */
export function aggregate(checkResults, metrics, scoringConfig = {}, durationMs = 0, timeoutSeconds = 120) {
  const weights = { ...DEFAULT_WEIGHTS, ...(scoringConfig.weights || {}) };
  const costBudgetUsd = scoringConfig.costBudgetUsd || DEFAULT_COST_BUDGET;

  const ftp = failToPassRate(checkResults.fail_to_pass || []);
  const ptp = passToPassRate(checkResults.pass_to_pass || []);

  const breakdown = {
    checksScore: checksScore(ftp, ptp),
    patchMinimalityScore: patchMinimalityScore(metrics.patch?.linesAdded || 0, metrics.patch?.linesRemoved || 0),
    toolCallScore: metrics.toolCalls == null ? null : toolCallScore(metrics.toolCalls),
    costScore: metrics.estimatedCostUsd == null ? null : costScore(metrics.estimatedCostUsd, costBudgetUsd),
    speedScore: speedScore(durationMs, timeoutSeconds * 1000)
  };
  const weightOf = {
    checksScore: weights.checks,
    patchMinimalityScore: weights.patchMinimality,
    toolCallScore: weights.toolCallCount,
    costScore: weights.costUsd,
    speedScore: weights.speedMs
  };

  let sum = 0;
  let wsum = 0;
  for (const [k, v] of Object.entries(breakdown)) {
    if (v == null) continue;
    sum += (weightOf[k] || 0) * v;
    wsum += weightOf[k] || 0;
  }
  const totalWeight = Object.values(weightOf).reduce((a, b) => a + (b || 0), 0);
  const score = clamp(wsum > 0 ? (sum / wsum) * totalWeight : 0);

  return {
    score: Math.round(score * 100) / 100,
    failToPassRate: ftp,
    passToPassRate: ptp,
    checks: checkResults,
    breakdown,
    compositeIsAuthoritative: false
  };
}
