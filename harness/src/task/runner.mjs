import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { validate } from "./schema.mjs";
import { isRemoteRepo } from "./loader.mjs";
import { runAll, determineOutcome } from "../evaluation/checks.mjs";
import { aggregate } from "../evaluation/scorer.mjs";
import { classifyFailure } from "../evaluation/taxonomy.mjs";
import { selectSandbox } from "../sandbox/manager.mjs";
import { PatchTracker } from "../tracking/patch-tracker.mjs";
import { AuditLog } from "../tracking/audit-log.mjs";
import { CostTracker } from "../tracking/cost-tracker.mjs";
import { writeReport } from "../report/generator.mjs";

const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const safe = (s) => String(s).replace(/[^\w.-]+/g, "_");

/**
 * Restore trusted evaluation files (scored test files / graders) from the
 * pristine fixture into the agent workspace. Called after the agent finishes
 * and after its patch has been captured, so test tampering is still recorded in
 * model_patch but can never change the grade. Bytes are read from the host
 * fixture (never the agent-writable workspace), so this cannot be subverted
 * from inside the sandbox. Returns { restored, tampered, missing } (all
 * workspace-relative). `tampered` = trusted paths the agent actually changed.
 */
export function restoreTrustedPaths(fixtureRoot, workdir, trustedPaths, changedFiles = []) {
  const root = resolve(fixtureRoot);
  const wd = resolve(workdir);
  const changed = new Set(changedFiles);
  const restored = [];
  const tampered = [];
  const missing = [];
  for (const rel of trustedPaths) {
    const src = resolve(root, rel);
    const dest = resolve(wd, rel);
    // Refuse any path that escapes the fixture or the workspace (`..`, abs).
    if (src !== root && !src.startsWith(root + "/")) { missing.push(rel); continue; }
    if (dest !== wd && !dest.startsWith(wd + "/")) { missing.push(rel); continue; }
    if (!existsSync(src)) { missing.push(rel); continue; }
    if (changed.has(rel)) tampered.push(rel);
    try {
      rmSync(dest, { recursive: true, force: true }); // neutralise file→dir swaps
      cpSync(src, dest, { recursive: true });
      restored.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { restored, tampered, missing };
}

export function makeRunId(taskId, agentId) {
  const ts = new Date().toISOString().replace(/[:\-.]/g, "").slice(0, 15);
  // random suffix: two attempts in the same second must never share an id
  return `run_${ts}_${safe(taskId)}_${safe(agentId)}_${randomBytes(3).toString("hex")}`;
}

let harnessInfo = null;
function getHarnessInfo() {
  if (harnessInfo) return harnessInfo;
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: HARNESS_DIR, stdio: "pipe" }).toString("utf8").trim();
    } catch {
      return null;
    }
  };
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(HARNESS_DIR, "package.json"), "utf8")).version;
  } catch { /* unknown */ }
  const status = git(["status", "--porcelain", "--", "."]);
  harnessInfo = {
    version,
    commit: git(["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    node: process.version,
    platform: `${process.platform}-${process.arch}`
  };
  return harnessInfo;
}

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function validateAgentResult(r) {
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") {
    return "malformed agent result (expected an object with boolean `ok`)";
  }
  return null;
}

export class TaskRunner {
  constructor({ runsDir = null, agentRegistry = null, selectSandbox: select = selectSandbox } = {}) {
    this.runsDir = runsDir;
    this.agentRegistry = agentRegistry;
    this._selectSandbox = select;
  }

  /**
   * One attempt. Every attempt starts from a fresh copy of the fixture (pinned
   * to task.commit when given). Pre-agent problems (invalid task, missing repo,
   * unavailable sandbox, invalid baseline) throw; anything after the agent
   * starts is captured in the returned record with status
   * pass | fail | incomplete | error (see determineOutcome).
   */
  async run(task, adapter, { runId = null } = {}) {
    const { valid, errors } = validate(task);
    if (!valid) {
      throw new Error(`Invalid task: ${errors.join(", ")}`);
    }
    if (!adapter || typeof adapter.run !== "function") {
      throw new Error("Invalid agent adapter: must implement run(task, context)");
    }

    if (isRemoteRepo(task.repo)) {
      throw new Error(`Task repo '${task.repo}' is a remote identifier, not a local checkout. Clone it locally and set repo: to the clone path${task.commit ? ` (the runner will check out ${task.commit})` : ""}.`);
    }
    const repoPath = resolve(task.repo);
    if (!existsSync(repoPath)) {
      throw new Error(`Task repo not found locally: ${repoPath}${/^[\w.-]+\/[\w.-]+$/.test(task.repo) ? " (looks like a GitHub owner/name — clone it first)" : ""}`);
    }

    const sandbox = this._selectSandbox(task);
    if (sandbox.type === "docker" && !adapter.supportsSandbox) {
      throw new Error(`Agent '${adapter.id}' executes commands on the host and cannot be isolated; refusing to run it on sandbox.type=docker task '${task.id}'`);
    }

    const agentId = adapter.id || "unknown";
    const rid = runId || makeRunId(task.id, agentId);
    const startedAt = Date.now();
    const auditLog = new AuditLog(rid);
    const timeoutSec = task.sandbox?.timeout || 120;
    const workdir = mkdtempSync(join(tmpdir(), `harness-${safe(task.id)}-`));

    // Ctrl-C / SIGTERM: containers and the workspace must not outlive the run
    const cleanup = () => {
      try { sandbox.teardown(); } catch { /* best effort */ }
      try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const onSignal = (sig) => {
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : 143);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      cpSync(repoPath, workdir, { recursive: true });

      const patchTracker = new PatchTracker(workdir);
      const initialCommit = await patchTracker.captureInitial({ commit: task.commit || null });
      await sandbox.setup(workdir);

      const baseline = await this._baseline(task, sandbox, patchTracker, initialCommit, timeoutSec, workdir);

      // ── Agent ────────────────────────────────────────────────────────────
      const agentContext = { workdir, sandbox: task.sandbox || {}, executor: sandbox, auditLog, task };
      let agentResult;
      let agentError = null;
      const agentStart = Date.now();
      try {
        agentResult = await adapter.run(task, agentContext);
        agentError = validateAgentResult(agentResult);
      } catch (err) {
        agentError = `adapter threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      const agentDurationMs = Date.now() - agentStart;
      if (agentError) {
        agentResult = { ok: false, error: agentError, turns: null, toolCalls: null, usage: null, events: [] };
      }
      if (auditLog.events().length === 0 && Array.isArray(agentResult.events)) {
        auditLog.recordEvents(agentResult.events);
      }
      auditLog.setAgentResult(agentResult);

      // ── Patch first, so checks' side effects never leak into it ───────────
      const patchRecord = await patchTracker.captureDiff(initialCommit);

      // ── Evaluation ───────────────────────────────────────────────────────
      let infraError = null;

      // Restore trusted evaluation files (scored tests / graders) from the
      // pristine fixture BEFORE any testPatch or checks. The agent's real edits
      // were already captured above (so tampering stays visible in model_patch),
      // but the agent must never grade itself by editing, renaming, weakening,
      // or deleting a scored test. Source bytes come from the host fixture, not
      // the agent-writable workspace, so this is not subvertible from the sandbox.
      let trustedRestore = null;
      if (Array.isArray(task.trustedPaths) && task.trustedPaths.length > 0) {
        trustedRestore = restoreTrustedPaths(repoPath, workdir, task.trustedPaths, patchRecord.filesChanged);
        if (trustedRestore.missing.length > 0) {
          infraError = `trustedPaths not found in the fixture (task misconfiguration): ${trustedRestore.missing.join(", ")}`;
        }
      }

      if (!infraError && task.testPatch) {
        try {
          await patchTracker.applyPatch(task.testPatch);
        } catch (err) {
          infraError = `test patch does not apply on top of the agent's changes: ${err.message}`;
        }
      }
      // Trusted evaluation context for trace-aware evaluators: the harness-
      // recorded tool-call trace (which the agent cannot forge) and the final
      // workspace. Shell checks ignore it.
      const evalCtx = { workdir, trace: auditLog.toolCalls(), task };
      const checkResults = { fail_to_pass: [], pass_to_pass: [], custom: [] };
      if (!infraError) {
        for (const group of Object.keys(checkResults)) {
          checkResults[group] = await runAll(task.checks[group] || [], sandbox, timeoutSec, evalCtx);
        }
      }

      const outcome = determineOutcome({ checks: checkResults, agentError, infraError });
      const status = outcome.status;

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const usage = agentResult.usage && typeof agentResult.usage === "object" ? agentResult.usage : null;
      const modelId = agentResult.model?.id ?? null;
      const estimatedCostUsd = new CostTracker(task.scoring?.costBudgetUsd || 1.0, modelId).estimate(usage);

      const metrics = {
        toolCalls: isCount(agentResult.toolCalls) ? agentResult.toolCalls : null,
        turns: isCount(agentResult.turns) ? agentResult.turns : null,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        estimatedCostUsd,
        costPerSuccessfulFix: status === "pass" ? estimatedCostUsd : null,
        agentDurationMs,
        patch: {
          filesChanged: patchRecord.filesChanged.length,
          linesAdded: patchRecord.linesAdded,
          linesRemoved: patchRecord.linesRemoved
        }
      };

      const evaluation = aggregate(checkResults, metrics, task.scoring || {}, durationMs, timeoutSec);

      const sandboxInfo = sandbox.describe();
      const runResult = {
        id: rid,
        instance_id: task.id,
        taskId: task.id,
        agentId,
        startedAt,
        completedAt,
        durationMs,
        status,
        outcome,
        evaluation: {
          ...evaluation,
          baseline,
          passAtK: { k1: status === "pass" ? 1.0 : status === "fail" ? 0.0 : null }
        },
        metrics,
        trace: {
          turns: auditLog.turns(),
          toolCalls: auditLog.toolCalls(),
          compactions: auditLog.compactions(),
          contextStrategyUsed: task.context?.strategy || "default",
          stopReason: agentResult.stopReason ?? null,
          agentOk: agentResult.ok,
          agentError: agentResult.ok ? null : (agentResult.error ?? null)
        },
        patch: {
          initialCommit,
          model_patch: patchRecord.unifiedDiff,
          filesChanged: patchRecord.filesChanged
        },
        sandbox: sandboxInfo,
        provenance: {
          harness: getHarnessInfo(),
          task: {
            id: task.id,
            version: task.version ?? null,
            specSha256: createHash("sha256").update(JSON.stringify(task)).digest("hex"),
            dataset: task._meta?.source ?? null,
            datasetVersion: task._meta?.version ?? null
          },
          repo: { source: task.repo, pinnedCommit: task.commit ?? null, initialCommit, testPatchApplied: !!task.testPatch && !infraError },
          agent: { id: agentId, adapter: adapter.constructor?.name ?? null, displayName: adapter.displayName ?? null },
          model: agentResult.model ?? null,
          limits: { maxTurns: task.agent?.maxTurns ?? null, maxTokens: task.agent?.maxTokens ?? null, timeoutSec },
          tools: agentResult.tools ?? null,
          environment: {
            image: sandboxInfo.image ?? null,
            envImage: sandboxInfo.envImage ?? null,
            envImageId: sandboxInfo.envImageId ?? null,
            dependencies: sandboxInfo.dependencies ?? null
          },
          seed: null
        },
        safety: {
          riskFlags: trustedRestore?.tampered?.length ? ["trusted_path_modified"] : [],
          secretsDetected: false,
          trustedPathsRestored: trustedRestore?.restored ?? null,
          tamperedTrustedPaths: trustedRestore?.tampered ?? null
        },
        failure: null,
        humanReview: null
      };

      runResult.failure = classifyFailure(runResult, task);

      if (this.runsDir) {
        await writeReport(runResult, this.runsDir);
      }

      return runResult;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      try {
        await sandbox.teardown();
      } catch {
        // ignore teardown errors
      }
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * Validates the task against the untouched repo (with the test patch, if
   * any): every pass_to_pass check must pass and every fail_to_pass check
   * must fail — otherwise a do-nothing agent could "pass". Then restores the
   * workspace so the agent starts from the pristine snapshot.
   */
  async _baseline(task, sandbox, patchTracker, initialCommit, timeoutSec, workdir = null) {
    const p2p = task.checks.pass_to_pass || [];
    const f2p = task.checks.fail_to_pass || [];
    // Trace-aware custom evaluators are agent-dependent acceptance checks (like
    // fail_to_pass): they MUST fail on the untouched repo (empty trace), or the
    // task would reward a no-op. Shell custom checks are left out of baseline
    // validation (they are often environment invariants, e.g. "running in a
    // container", that legitimately hold before the agent runs).
    const customAcceptance = (task.checks.custom || []).filter((c) => c.required !== false && typeof c.evaluator === "string");
    if (p2p.length === 0 && f2p.length === 0 && customAcceptance.length === 0) {
      return { pass_to_pass: [], fail_to_pass: [], custom: [] };
    }

    if (task.testPatch) {
      try {
        await patchTracker.applyPatch(task.testPatch);
      } catch (err) {
        throw new Error(`Baseline failed: test patch does not apply to the base repo: ${err.message}`, { cause: err });
      }
    }
    // No agent has run → empty trace. A trace-aware acceptance check must fail
    // against the pristine workspace exactly as a fail_to_pass command does.
    const baselineCtx = { workdir, trace: [], task };
    const p2pResults = await runAll(p2p, sandbox, timeoutSec, baselineCtx);
    const f2pResults = await runAll(f2p, sandbox, timeoutSec, baselineCtx);
    const customResults = await runAll(customAcceptance, sandbox, timeoutSec, baselineCtx);
    await patchTracker.reset(initialCommit);

    const broken = [...p2pResults, ...f2pResults, ...customResults].filter((r) => r.infraError);
    if (broken.length > 0) {
      throw new Error(`Baseline failed: checks could not be executed: ${broken.map((r) => `${r.id} (${r.infraError})`).join(", ")}`);
    }
    const p2pFailed = p2pResults.filter((r) => !r.passed);
    if (p2pFailed.length > 0) {
      throw new Error(`Baseline failed: pass_to_pass checks were already failing before agent ran: ${p2pFailed.map((r) => r.id).join(", ")}`);
    }
    const accPassing = [...f2pResults, ...customResults].filter((r) => r.passed);
    if (accPassing.length > 0) {
      throw new Error(`Baseline invalid: acceptance (fail_to_pass/custom) checks already pass before agent ran (task would reward a no-op): ${accPassing.map((r) => r.id).join(", ")}`);
    }
    const brief = (r) => ({ id: r.id, passed: r.passed, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs });
    return { pass_to_pass: p2pResults.map(brief), fail_to_pass: f2pResults.map(brief), custom: customResults.map(brief) };
  }
}
