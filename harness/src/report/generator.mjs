import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

export function toMarkdown(run) {
  const status = run.status === "pass" ? "PASS ✓" : "FAIL ✗";
  const score = Math.round((run.evaluation?.score || 0) * 100);
  const e = run.evaluation || {};
  const m = run.metrics || {};
  const p = m.patch || {};

  const lines = [
    `## Harness Run Report`,
    `Agent:   ${run.agentId}`,
    `Task:    ${run.taskId}${run.evaluation?.difficulty ? ` (${run.evaluation.difficulty})` : ""}`,
    `Status:  ${status}  |  Score: ${score}/100`,
    ``,
    `### Test Results`
  ];

  const checks = e.checks || {};
  for (const r of checks.fail_to_pass || []) {
    lines.push(`${r.passed ? "✓" : "✗"} FAIL_TO_PASS  ${r.id.padEnd(24)} ${r.durationMs}ms`);
  }
  for (const r of checks.pass_to_pass || []) {
    lines.push(`${r.passed ? "✓" : "✗"} PASS_TO_PASS  ${r.id.padEnd(24)} ${r.durationMs}ms`);
  }
  for (const r of checks.custom || []) {
    lines.push(`${r.passed ? "✓" : "✗"} custom        ${r.id.padEnd(24)} ${r.durationMs}ms`);
  }

  lines.push(``);
  lines.push(`### Metrics`);
  lines.push(`Tool calls: ${String(m.toolCalls || 0).padStart(4)}    |  Turns: ${m.turns || 0}`);
  lines.push(`Tokens:  ${String(m.totalTokens || 0).padStart(6)}    |  Cost:  $${(m.estimatedCostUsd || 0).toFixed(4)}`);
  lines.push(`Time:     ${String(run.durationMs || 0).padStart(5)}ms  |  Patch: +${p.linesAdded || 0}/-${p.linesRemoved || 0} (${p.filesChanged || 0} file${p.filesChanged === 1 ? "" : "s"})`);
  if (m.costPerSuccessfulFix) {
    lines.push(`Cost/fix: $${m.costPerSuccessfulFix.toFixed(4)}`);
  }

  lines.push(``);
  lines.push(`### Safety`);
  const flags = run.safety?.riskFlags || [];
  lines.push(`Risk flags:  ${flags.length === 0 ? "none" : flags.join(", ")}`);

  lines.push(``);
  lines.push(`### Failure Classification`);
  if (!run.failure) {
    lines.push(`None (task completed successfully)`);
  } else {
    lines.push(`Dimension: ${run.failure.dimension}`);
    lines.push(`Symptom:   ${run.failure.symptom}`);
    lines.push(`Evidence:  ${run.failure.evidence}`);
  }

  return lines.join("\n");
}

export function toJSON(run) {
  return JSON.stringify(run, null, 2);
}

export function toPredictionsJsonl(runs) {
  return runs
    .map((r) => JSON.stringify({
      instance_id: r.instance_id || r.taskId,
      model_name_or_path: r.agentId,
      model_patch: r.patch?.model_patch || ""
    }))
    .join("\n");
}

export async function writeReport(run, runsDir) {
  mkdirSync(runsDir, { recursive: true });
  const jsonPath = join(runsDir, `${run.id}.json`);
  writeFileSync(jsonPath, toJSON(run), "utf8");
  return jsonPath;
}
