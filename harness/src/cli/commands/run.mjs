import { resolve } from "node:path";
import { loadTask } from "../../task/loader.mjs";
import { TaskRunner } from "../../task/runner.mjs";
import { defaultRegistry } from "../../agent/registry.mjs";
import { toMarkdown } from "../../report/generator.mjs";
import { summarizeAttempts } from "../../evaluation/pass-at-k.mjs";

/** Resolve through the shared AgentRegistry; throws a clear error if unknown/unavailable. */
export function resolveAgent(agentId, options = {}, registry = defaultRegistry) {
  const adapter = registry.resolve(agentId, { model: options.model });
  if (!adapter.isAvailable()) {
    throw new Error(`Agent '${agentId}' is not available (missing API key or binary).`);
  }
  return adapter;
}

export async function runCommand(argv, options = {}) {
  const taskPath = argv[0];
  if (!taskPath) {
    console.error("Usage: harness run <task.yaml> [--agent <id>] [--model M] [--k N] [--runs-dir ./runs]");
    process.exitCode = 1;
    return;
  }

  const agentId = options.agent || "mock";
  const k = parseInt(options.k || "1", 10);
  if (!Number.isInteger(k) || k < 1) {
    console.error(`--k must be a positive integer (got ${options.k})`);
    process.exitCode = 1;
    return;
  }
  const runsDir = resolve(options["runs-dir"] || options.runsDir || "runs");

  let task;
  try {
    task = loadTask(resolve(taskPath));
  } catch (err) {
    console.error(`Failed to load task: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let adapter;
  try {
    adapter = resolveAgent(agentId, options);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const runner = new TaskRunner({ runsDir });

  console.log(`Running task: ${task.id}  agent: ${adapter.displayName}  k=${k}`);

  const runs = [];
  for (let i = 0; i < k; i++) {
    if (k > 1) process.stdout.write(`  run ${i + 1}/${k}... `);
    try {
      const result = await runner.run(task, adapter);
      runs.push(result);
      if (k > 1) console.log(result.status.toUpperCase());
    } catch (err) {
      if (k > 1) console.log("ERROR");
      console.error(`Run ${i + 1} failed: ${err.message}`);
      runs.push({ status: "error", error: err.message });
    }
  }

  const lastRun = runs.findLast((r) => r.id);
  if (lastRun) {
    console.log("\n" + toMarkdown(lastRun));
  }

  if (k > 1) {
    const s = summarizeAttempts(runs, k);
    const pct = (v) => (v == null ? "unknown" : `${(v * 100).toFixed(1)}%`);
    console.log(`\nattempts: ${s.attempts}  pass: ${s.passed}  fail: ${s.failed}  error: ${s.errored}  incomplete: ${s.incomplete}`);
    console.log(`pass@${k}: ${pct(s.passAtK)}   pass^${k}: ${pct(s.passHatK)}`);
  }

  const anyPassed = runs.some((r) => r.status === "pass");
  if (!anyPassed) process.exitCode = 1;
}
