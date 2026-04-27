import { resolve } from "node:path";
import { loadTask } from "../../task/loader.mjs";
import { TaskRunner } from "../../task/runner.mjs";
import { MockAgent } from "../../agent/adapters/mock.mjs";
import { UpstageAgent } from "../../agent/adapters/upstage.mjs";
import { toMarkdown } from "../../report/generator.mjs";
import { passAtK } from "../../evaluation/pass-at-k.mjs";

function resolveAgent(agentId, options = {}) {
  switch (agentId) {
    case "mock": return new MockAgent();
    case "upstage":
    case "solar":
    case "solar-pro2": return new UpstageAgent({ model: options.model });
    default:
      throw new Error(`Unknown agent: ${agentId}. Available: mock, upstage`);
  }
}

export async function runCommand(argv, options = {}) {
  const taskPath = argv[0];
  if (!taskPath) {
    console.error("Usage: harness run <task.yaml> [--agent mock|upstage] [--k N] [--runs-dir ./runs]");
    process.exitCode = 1;
    return;
  }

  const agentId = options.agent || "mock";
  const k = parseInt(options.k || "1", 10);
  const runsDir = resolve(options.runsDir || "runs");

  let task;
  try {
    task = loadTask(resolve(taskPath));
  } catch (err) {
    console.error(`Failed to load task: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const adapter = resolveAgent(agentId, options);

  if (!adapter.isAvailable()) {
    console.error(`Agent '${agentId}' is not available (missing API key or binary).`);
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
      if (k > 1) console.log(result.status === "pass" ? "PASS" : "FAIL");
    } catch (err) {
      if (k > 1) console.log("ERROR");
      console.error(`Run ${i + 1} failed: ${err.message}`);
      runs.push({ status: "fail", ok: false });
    }
  }

  const lastRun = runs.find((r) => r.id) || runs[runs.length - 1];
  if (lastRun?.id) {
    console.log("\n" + toMarkdown(lastRun));
  }

  if (k > 1) {
    const rate = passAtK(runs, k);
    console.log(`\npass@${k}: ${(rate * 100).toFixed(1)}%`);
  }

  const anyPassed = runs.some((r) => r.status === "pass");
  if (!anyPassed) process.exitCode = 1;
}
