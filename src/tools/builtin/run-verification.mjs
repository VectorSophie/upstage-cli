// 3.3.0 Thread E, Task E.1 — "see it, run it, prove it": this is where the
// final evidence bundle is assembled, not a second orchestrator. Two
// sources, both optional, neither can fail the run by being absent:
//   - auto-collected: any stage result carrying a docker-log artifact
//     (Thread B — a stage ran with sandbox:"docker" and a sessionId)
//   - caller-supplied: `args.evidence`, whatever the agent already
//     gathered itself via browser_console/browser_screenshot/inspect_image
//     (Threads C/D) earlier in the same verification flow — this tool
//     doesn't call those itself, it just has somewhere to put the result.
export function collectEvidence(results, callerEvidence) {
  const evidence = {};

  const dockerLogs = (results || [])
    .map((r) => r.data?.artifact)
    .filter((a) => a && a.kind === "docker-log");
  if (dockerLogs.length > 0) evidence.dockerLogs = dockerLogs;

  if (callerEvidence && typeof callerEvidence === "object" && !Array.isArray(callerEvidence)) {
    for (const [key, value] of Object.entries(callerEvidence)) {
      if (value !== undefined) evidence[key] = value;
    }
  }

  return evidence;
}

export const runVerificationTool = {
  name: "run_verification",
  description: "Run linter, typecheck, and tests in order, and assemble a final evidence bundle (docker/browser/vision) if any was produced",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      stopOnFailure: { type: "boolean" },
      sandbox: { type: "string", enum: ["local", "docker"] },
      stages: {
        type: "array",
        items: {
          type: "string",
          enum: ["run_linter", "run_typecheck", "run_tests"]
        }
      },
      // Evidence the agent already collected via browser_console/
      // browser_screenshot/inspect_image earlier in this verification
      // flow — passed through as-is into the final result's `evidence`.
      evidence: { type: "object" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    const stopOnFailure = args.stopOnFailure !== false;
    const defaultStages = ["run_linter", "run_typecheck", "run_tests"];
    const selectedStages =
      Array.isArray(args.stages) && args.stages.length > 0
        ? args.stages.filter((stage) => defaultStages.includes(stage))
        : defaultStages;
    const stages = selectedStages.length > 0 ? selectedStages : defaultStages;
    const results = [];

    for (const stage of stages) {
      const result = await context.executeTool(stage, { sandbox: args.sandbox }, { onLog: context.onLog });
      // Pre-existing bug, fixed here (3.3.0 Thread E, Task E.1): `result.ok`
      // is the REGISTRY's "did the tool throw" — not the stage's own
      // pass/fail, which every verification stage tool reports via
      // `result.data.ok` (e.g. a nonzero lint exit code still resolves
      // without throwing). Using `result.ok` alone meant a genuinely
      // failing stage was reported as passed as long as it didn't crash.
      const stageOk = result.ok === true && result.data?.ok !== false;
      const entry = {
        stage,
        ok: stageOk,
        data: result.data,
        error: result.error
      };
      results.push(entry);
      context.onLog?.({ stage: "verify", channel: "summary", text: `${stage}: ${stageOk ? "ok" : "failed"}` });
      if (stopOnFailure && !stageOk) {
        break;
      }
    }

    return {
      ok: results.every((item) => item.ok),
      results,
      evidence: collectEvidence(results, args.evidence)
    };
  }
};
