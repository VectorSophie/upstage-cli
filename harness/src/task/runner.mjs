import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { validate } from "./schema.mjs";
import { runAll } from "../evaluation/checks.mjs";
import { aggregate } from "../evaluation/scorer.mjs";
import { classifyFailure } from "../evaluation/taxonomy.mjs";
import { PatchTracker } from "../tracking/patch-tracker.mjs";
import { AuditLog } from "../tracking/audit-log.mjs";
import { CostTracker } from "../tracking/cost-tracker.mjs";
import { writeReport } from "../report/generator.mjs";

function makeRunId(taskId, agentId) {
  const ts = new Date().toISOString().replace(/[:\-\.]/g, "").slice(0, 15);
  return `run_${ts}_${taskId}_${agentId}`;
}

function gitExec(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

export class TaskRunner {
  constructor({ runsDir = null, agentRegistry = null } = {}) {
    this.runsDir = runsDir;
    this.agentRegistry = agentRegistry;
  }

  async run(task, adapter, { runId = null, k = 1 } = {}) {
    // Step 1: Validate task spec
    const { valid, errors } = validate(task);
    if (!valid) {
      throw new Error(`Invalid task: ${errors.join(", ")}`);
    }

    const agentId = adapter.id || "unknown";
    const rid = runId || makeRunId(task.id, agentId);
    const startedAt = Date.now();
    const auditLog = new AuditLog(rid);
    const costTracker = new CostTracker(task.scoring?.costBudgetUsd || 1.0);

    // Step 2: Copy fixture repo to temp workdir
    const repoPath = resolve(task.repo);
    const workdir = mkdtempSync(join(tmpdir(), `harness-${task.id}-`));

    try {
      cpSync(repoPath, workdir, { recursive: true });

      // Step 3: git init + initial commit
      const patchTracker = new PatchTracker(workdir);
      const initialCommit = await patchTracker.captureInitial();

      // Step 4: Baseline — verify pass_to_pass checks pass before agent runs
      const passToPassChecks = task.checks.pass_to_pass || [];
      if (passToPassChecks.length > 0) {
        const baseline = await runAll(passToPassChecks, workdir, task.sandbox?.timeout || 120);
        const baselineFailed = baseline.filter((r) => !r.passed);
        if (baselineFailed.length > 0) {
          throw new Error(`Baseline failed: pass_to_pass checks were already failing before agent ran: ${baselineFailed.map((r) => r.id).join(", ")}`);
        }
      }

      // Step 5: Build agent context (simple for now; Phase D adds strategies)
      const agentContext = {
        workdir,
        sandbox: task.sandbox || {},
        auditLog,
        costTracker,
        task
      };

      // Step 6: Run agent
      let agentResult;
      try {
        agentResult = await adapter.run(task, agentContext);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentResult = { ok: false, error: msg, turns: 0, toolCalls: 0, usage: null, events: [] };
      }

      auditLog.setAgentResult(agentResult);

      // Step 7: Run all checks
      const failToPassResults = await runAll(task.checks.fail_to_pass || [], workdir, task.sandbox?.timeout || 120);
      const passToPassResults = await runAll(passToPassChecks, workdir, task.sandbox?.timeout || 120);
      const customResults = await runAll(task.checks.custom || [], workdir, task.sandbox?.timeout || 120);

      // Step 8: Compute score
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const usage = agentResult.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const estimatedCostUsd = costTracker.estimate(usage);

      const metrics = {
        toolCalls: agentResult.toolCalls || 0,
        turns: agentResult.turns || 0,
        promptTokens: usage.promptTokens || 0,
        completionTokens: usage.completionTokens || 0,
        totalTokens: usage.totalTokens || 0,
        estimatedCostUsd,
        costPerSuccessfulFix: 0,
        patch: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
      };

      const evaluation = aggregate(
        { fail_to_pass: failToPassResults, pass_to_pass: passToPassResults, custom: customResults },
        metrics,
        task.scoring || {},
        durationMs,
        task.sandbox?.timeout || 120
      );

      // Step 9: Compute patch diff
      const patchRecord = await patchTracker.captureDiff(initialCommit);
      metrics.patch = {
        filesChanged: patchRecord.filesChanged.length,
        linesAdded: patchRecord.linesAdded,
        linesRemoved: patchRecord.linesRemoved
      };
      if (evaluation.failToPassRate === 1.0 && evaluation.score > 0) {
        metrics.costPerSuccessfulFix = estimatedCostUsd;
      }

      // Step 10: Classify failure
      const status = evaluation.failToPassRate === 1.0 && evaluation.passToPassRate === 1.0 ? "pass" : "fail";
      const runResult = {
        id: rid,
        instance_id: task.id,
        taskId: task.id,
        agentId,
        startedAt,
        completedAt,
        durationMs,
        status,
        evaluation: { ...evaluation, passAtK: { k1: status === "pass" ? 1.0 : 0.0 } },
        metrics,
        trace: {
          turns: auditLog.turns(),
          toolCalls: auditLog.toolCalls(),
          compactions: auditLog.compactions(),
          contextStrategyUsed: task.context?.strategy || "default"
        },
        patch: {
          initialCommit,
          model_patch: patchRecord.unifiedDiff,
          filesChanged: patchRecord.filesChanged
        },
        safety: { riskFlags: [], secretsDetected: false },
        failure: null,
        humanReview: null
      };

      runResult.failure = classifyFailure(runResult, task);

      // Step 11: Persist artifact
      if (this.runsDir) {
        await writeReport(runResult, this.runsDir);
      }

      return runResult;
    } finally {
      // Cleanup temp workdir
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
