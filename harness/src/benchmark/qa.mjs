// Candidate-task QA — validates tasks WITHOUT any model inference.
//
// For each task it checks, in the real (Docker) sandbox:
//   - baseline : on the pristine fixture, every required acceptance check FAILS
//                and every pass_to_pass check PASSES (a no-op cannot pass; the
//                p2p "sanity" still holds). This is also the no-op negative.
//   - solution : a known-correct solution makes acceptance PASS and p2p PASS.
//                File-based tasks overlay a reference solution from
//                benchmarks/v1/solutions/<id>/. Trace-evaluator (category D)
//                tasks instead EXECUTE the trusted mounted generator and write
//                its stdout token — proving the intended path with no model.
//
// Mechanical only: it does not prove the acceptance check rejects every wrong
// answer or accepts every reasonable alternative — that needs human review
// (see docs/BENCHMARK_V1_TASK_QA.md).

import { mkdtempSync, cpSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { runAll } from "../evaluation/checks.mjs";
import { selectSandbox } from "../sandbox/manager.mjs";
import { SOLUTIONS_DIR } from "./manifest.mjs";

function mkWorkspace(task) {
  const wd = mkdtempSync(join(tmpdir(), "bv1-qa-"));
  cpSync(resolve(task.repo), wd, { recursive: true });
  return wd;
}

function overlay(srcDir, wd) {
  for (const name of readdirSync(srcDir)) {
    const p = join(srcDir, name);
    cpSync(p, join(wd, name), { recursive: true });
  }
}

const required = (checks) => [...(checks.fail_to_pass || []), ...(checks.custom || [])].filter((c) => c.required !== false);

async function runGroups(task, sandbox, wd, trace) {
  const t = task.sandbox?.timeout || 120;
  const ctx = { workdir: wd, trace: trace || [], task };
  return {
    acceptance: await runAll(required(task.checks), sandbox, t, ctx),
    p2p: await runAll(task.checks.pass_to_pass || [], sandbox, t, ctx)
  };
}

function summarize(r) {
  const infra = [...r.acceptance, ...r.p2p].filter((c) => c.infraError);
  return {
    acceptancePassed: r.acceptance.filter((c) => c.passed).map((c) => c.id),
    acceptanceFailed: r.acceptance.filter((c) => !c.passed && !c.infraError).map((c) => c.id),
    p2pPassed: r.p2p.filter((c) => c.passed).map((c) => c.id),
    p2pFailed: r.p2p.filter((c) => !c.passed && !c.infraError).map((c) => c.id),
    infraErrors: infra.map((c) => `${c.id}: ${c.infraError}`)
  };
}

/** Execute a trace-evaluator task's intended generator command and write its token. */
async function driveTraceSolution(task, sandbox, wd) {
  const custom = (task.checks.custom || []).find((c) => c.evaluator === "tool-result-continuation");
  const cfg = custom.config || {};
  const argv = String(cfg.command).trim().split(/\s+/);
  const r = await sandbox.exec(argv[0], argv.slice(1), { timeoutMs: (task.sandbox?.timeout || 120) * 1000 });
  const re = new RegExp(cfg.tokenPattern || "T3-[0-9a-f]{32}");
  const m = (r.stdout || "").match(re);
  if (!m) throw new Error(`generator produced no token matching ${re} (stdout=${JSON.stringify((r.stdout || "").slice(0, 60))})`);
  writeFileSync(join(wd, cfg.outputFile || "out.txt"), m[0]);
  return [{ tool: "run_shell", ok: true, args: { command: cfg.command }, resultData: { ok: r.ok === true, code: r.exitCode ?? 0, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: !!r.timedOut, truncated: false } }];
}

export async function qaTask(task) {
  const isTrace = (task.checks.custom || []).some((c) => c.evaluator);
  const solDir = join(SOLUTIONS_DIR, task.id);
  const hasFileSolution = !isTrace && statSafe(solDir);
  const out = { id: task.id, mode: isTrace ? "trace" : (hasFileSolution ? "file-overlay" : "none"), ok: false, baseline: null, solution: null, verdict: null };

  if (!isTrace && !hasFileSolution) {
    out.verdict = "no reference solution available (cannot auto-validate)";
    return out;
  }

  // ── baseline ──
  let sandbox = selectSandbox(task);
  let wd = mkWorkspace(task);
  try {
    await sandbox.setup(wd);
    out.baseline = summarize(await runGroups(task, sandbox, wd, []));
  } finally { await safeTeardown(sandbox); rmSafe(wd); }

  // ── solution ──
  sandbox = selectSandbox(task);
  wd = mkWorkspace(task);
  let trace = [];
  try {
    await sandbox.setup(wd);
    if (isTrace) trace = await driveTraceSolution(task, sandbox, wd);
    else overlay(solDir, wd);
    out.solution = summarize(await runGroups(task, sandbox, wd, trace));
  } finally { await safeTeardown(sandbox); rmSafe(wd); }

  // ── verdict ──
  const b = out.baseline, s = out.solution;
  const problems = [];
  if (b.infraErrors.length || s.infraErrors.length) problems.push(`infra: ${[...b.infraErrors, ...s.infraErrors].join("; ")}`);
  if (b.acceptancePassed.length) problems.push(`baseline acceptance should all fail, but passed: ${b.acceptancePassed.join(", ")}`);
  if (b.p2pFailed.length) problems.push(`baseline p2p should all pass, but failed: ${b.p2pFailed.join(", ")}`);
  if (s.acceptanceFailed.length) problems.push(`solution acceptance should all pass, but failed: ${s.acceptanceFailed.join(", ")}`);
  if (s.p2pFailed.length) problems.push(`solution p2p should all pass, but failed: ${s.p2pFailed.join(", ")}`);
  out.ok = problems.length === 0;
  out.verdict = out.ok ? "OK: baseline fails, solution passes, no-op fails, sanity holds" : problems.join(" | ");
  return out;
}

export async function qaAll(tasks) {
  const results = [];
  for (const t of tasks) results.push(await qaTask(t));
  return results;
}

function statSafe(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function rmSafe(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
async function safeTeardown(sb) { try { await sb.teardown(); } catch { /* best effort */ } }
