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

export function aggregate(checkResults, metrics, scoringConfig = {}, durationMs = 0, timeoutSeconds = 120) {
  const weights = { ...DEFAULT_WEIGHTS, ...(scoringConfig.weights || {}) };
  const costBudgetUsd = scoringConfig.costBudgetUsd || DEFAULT_COST_BUDGET;

  const ftp = failToPassRate(checkResults.fail_to_pass || []);
  const ptp = passToPassRate(checkResults.pass_to_pass || []);

  const cs = checksScore(ftp, ptp);
  const pm = patchMinimalityScore(metrics.patch?.linesAdded || 0, metrics.patch?.linesRemoved || 0);
  const tc = toolCallScore(metrics.toolCalls || 0);
  const co = costScore(metrics.estimatedCostUsd || 0, costBudgetUsd);
  const sp = speedScore(durationMs, timeoutSeconds * 1000);

  const score = clamp(
    weights.checks * cs +
    weights.patchMinimality * pm +
    weights.toolCallCount * tc +
    weights.costUsd * co +
    weights.speedMs * sp
  );

  return {
    score: Math.round(score * 100) / 100,
    failToPassRate: ftp,
    passToPassRate: ptp,
    checks: checkResults,
    breakdown: { checksScore: cs, patchMinimalityScore: pm, toolCallScore: tc, costScore: co, speedScore: sp }
  };
}
