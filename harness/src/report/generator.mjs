import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const fmt = (v, f = String) => (v == null ? "unknown" : f(v));

export function toMarkdown(run) {
  const status = ({ pass: "PASS ✓", fail: "FAIL ✗", error: "ERROR ✗ (not scored)", incomplete: "INCOMPLETE ✗ (not scored)" })[run.status] || "FAIL ✗";
  const score = Math.round((run.evaluation?.score || 0) * 100);
  const e = run.evaluation || {};
  const m = run.metrics || {};
  const p = m.patch || {};

  const lines = [
    `## Harness Run Report`,
    `Agent:   ${run.agentId}`,
    `Task:    ${run.taskId}${run.evaluation?.difficulty ? ` (${run.evaluation.difficulty})` : ""}`,
    `Status:  ${status}  |  Legacy composite: ${score}/100 (non-authoritative)`,
    ...(run.outcome && run.status !== "pass" ? [`Reason:  ${run.outcome.reason}${run.outcome.detail ? ` — ${run.outcome.detail}` : ""}`] : []),
    ``,
    `### Test Results`
  ];

  const checks = e.checks || {};
  const mark = (r) => (r.infraError ? "!" : r.passed ? "✓" : "✗");
  const note = (r) => (r.timedOut ? " (timeout)" : r.infraError ? " (infra error)" : r.required === false ? " (optional)" : "");
  for (const [label, group] of [["FAIL_TO_PASS", checks.fail_to_pass], ["PASS_TO_PASS", checks.pass_to_pass], ["custom      ", checks.custom]]) {
    for (const r of group || []) {
      lines.push(`${mark(r)} ${label}  ${r.id.padEnd(24)} ${r.durationMs}ms${note(r)}`);
    }
  }
  if (Object.values(checks).every((g) => !g || g.length === 0)) lines.push("(no checks executed)");

  lines.push(``);
  lines.push(`### Metrics`);
  lines.push(`Tool calls: ${fmt(m.toolCalls).padStart(4)}    |  Turns: ${fmt(m.turns)}`);
  lines.push(`Tokens:  ${fmt(m.totalTokens).padStart(6)}    |  Cost:  ${fmt(m.estimatedCostUsd, (v) => `$${v.toFixed(4)}`)}`);
  lines.push(`Time:     ${String(run.durationMs || 0).padStart(5)}ms  |  Patch: +${p.linesAdded || 0}/-${p.linesRemoved || 0} (${p.filesChanged || 0} file${p.filesChanged === 1 ? "" : "s"})`);
  if (run.sandbox) {
    lines.push(`Sandbox:  ${run.sandbox.type}${run.sandbox.type === "docker" ? ` (${run.sandbox.image}, network=${run.sandbox.network?.effective})` : " (trusted, not isolated)"}`);
  }
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

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Replace every host secret value (from credential-looking env vars) found in `text`. */
export function redactSecrets(text, env = process.env) {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_RE.test(k) || typeof v !== "string" || v.length < 8) continue;
    out = out.split(v).join(`[REDACTED:${k}]`);
    // also the JSON-escaped form, in case the value contains quotes/backslashes
    const esc = JSON.stringify(v).slice(1, -1);
    if (esc !== v) out = out.split(esc).join(`[REDACTED:${k}]`);
  }
  return out;
}

export async function writeReport(run, runsDir) {
  mkdirSync(runsDir, { recursive: true });
  const jsonPath = join(runsDir, `${run.id}.json`);
  // "wx": a run id collision must fail loudly, never overwrite an earlier result
  writeFileSync(jsonPath, redactSecrets(toJSON(run)), { encoding: "utf8", flag: "wx" });
  return jsonPath;
}
