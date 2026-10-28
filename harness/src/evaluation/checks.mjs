import { NativeSandbox } from "../sandbox/native.mjs";
import { runEvaluatorCheck } from "./evaluators.mjs";

const OUTPUT_LIMIT = 4000;

/**
 * Runs one check. A check is EITHER a shell command run through `sandbox`
 * (a NativeSandbox/DockerSandbox, or a workdir string for a one-off native run)
 * OR a trace-aware evaluator named by `check.evaluator`, which runs in the
 * trusted harness process against `ctx` ({ workdir, trace, task }).
 *
 * Result: { id, passed, exitCode, timedOut, infraError, durationMs, stdout, stderr, weight, required }
 * `infraError` is set when the check could not be executed at all (docker
 * daemon error, spawn failure, unknown evaluator) — an evaluation error, not a
 * failure.
 */
export async function runCheck(check, sandbox, defaultTimeout = 120, ctx = null) {
  if (check.evaluator) {
    return runEvaluatorCheck(check, ctx || {});
  }
  const sb = typeof sandbox === "string" ? nativeFor(sandbox) : sandbox;
  const timeoutMs = (check.timeout || defaultTimeout) * 1000;
  const r = await sb.execShell(check.command, { timeoutMs });
  return {
    id: check.id,
    passed: r.ok === true && !r.infraError,
    exitCode: r.exitCode,
    timedOut: !!r.timedOut,
    infraError: r.infraError || r.spawnError || null,
    durationMs: r.durationMs,
    stdout: r.ok ? "" : (r.stdout || "").slice(0, OUTPUT_LIMIT),
    stderr: r.ok ? "" : (r.stderr || "").slice(0, OUTPUT_LIMIT),
    weight: check.weight ?? 1.0,
    required: check.required !== false
  };
}

export async function runAll(checks, sandbox, defaultTimeout = 120, ctx = null) {
  const results = [];
  for (const check of checks) {
    results.push(await runCheck(check, sandbox, defaultTimeout, ctx));
  }
  return results;
}

function nativeFor(workdir) {
  const sb = new NativeSandbox({ sandbox: {} });
  sb._workdir = workdir;
  return sb;
}

// Legacy composite-score inputs: an empty list counts as 1.0 here. The
// authoritative pass/fail is determineOutcome(), which treats "no checks" as
// incomplete, never as success.
export function failToPassRate(results) {
  if (!results || results.length === 0) return 1.0;
  const passed = results.filter((r) => r.passed).length;
  return passed / results.length;
}

export function passToPassRate(results) {
  if (!results || results.length === 0) return 1.0;
  const passed = results.filter((r) => r.passed).length;
  return passed / results.length;
}

/**
 * Authoritative run status, derived only from actually executed checks.
 *
 *   pass       — ≥1 required acceptance check (fail_to_pass or required custom)
 *                ran, and every required check in every group passed
 *   fail       — the agent's patch failed a required check
 *   incomplete — no required acceptance checks were defined / executed
 *   error      — the harness or adapter failed; result is not attributable to the agent
 *
 * Non-required (required: false) checks are reported but never decide status.
 */
export function determineOutcome({ checks = {}, agentError = null, infraError = null } = {}) {
  if (infraError) return { status: "error", reason: "infrastructure_error", detail: infraError };
  if (agentError) return { status: "error", reason: "agent_adapter_error", detail: agentError };

  const all = [...(checks.fail_to_pass || []), ...(checks.pass_to_pass || []), ...(checks.custom || [])];
  const broken = all.find((r) => r.infraError);
  if (broken) return { status: "error", reason: "check_infrastructure_error", detail: `${broken.id}: ${broken.infraError}` };

  const acceptance = [...(checks.fail_to_pass || []), ...(checks.custom || [])].filter((r) => r.required !== false);
  if (acceptance.length === 0) {
    return { status: "incomplete", reason: "no_required_acceptance_checks", detail: "task defines no required fail_to_pass/custom checks" };
  }

  const failed = all.filter((r) => r.required !== false && !r.passed);
  if (failed.length > 0) {
    const timedOut = failed.filter((r) => r.timedOut);
    return {
      status: "fail",
      reason: timedOut.length > 0 ? "check_timeout" : "required_check_failed",
      detail: failed.map((r) => r.id).join(", ")
    };
  }
  return { status: "pass", reason: "all_required_checks_passed", detail: null };
}
