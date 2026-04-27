import { resolve } from "node:path";
import { loadTask } from "../../task/loader.mjs";
import { TaskRunner } from "../../task/runner.mjs";
import { AgentRegistry } from "../../agent/registry.mjs";
import { comparisonTable } from "../../report/table.mjs";
import { toJSON } from "../../report/generator.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export async function compareCommand(argv, options = {}) {
  const taskPath = argv[0];
  const agentIds = parseAgentList(options.agent);

  if (!taskPath || agentIds.length < 1) {
    console.error("Usage: harness compare <task.yaml> --agent A --agent B [--parallel] [--runs-dir ./runs]");
    process.exitCode = 1;
    return;
  }

  const runsDir = resolve(options["runs-dir"] || options.runsDir || "runs");
  const parallel = options.parallel === true || options.parallel === "true";

  let task;
  try {
    task = loadTask(resolve(taskPath));
  } catch (err) {
    console.error(`Failed to load task: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const registry = new AgentRegistry();
  const adapters = [];
  for (const id of agentIds) {
    try {
      const adapter = registry.resolve(id);
      if (!adapter.isAvailable()) {
        console.warn(`  [warn] agent '${id}' is not available — skipping`);
        continue;
      }
      adapters.push(adapter);
    } catch (err) {
      console.error(`  [error] ${err.message}`);
    }
  }

  if (adapters.length === 0) {
    console.error("No available agents to compare.");
    process.exitCode = 1;
    return;
  }

  console.log(`Comparing ${adapters.length} agent(s) on task: ${task.id}\n`);

  const runner = new TaskRunner({ runsDir });
  let runs;

  if (parallel) {
    runs = await Promise.all(
      adapters.map((adapter) =>
        runner.run(task, adapter).catch((err) => ({
          agentId: adapter.id,
          status: "error",
          error: err.message,
          evaluation: { score: 0, failToPassRate: 0, passToPassRate: 0 },
          metrics: { toolCalls: 0, estimatedCostUsd: 0, patch: { linesAdded: 0, linesRemoved: 0 } },
          durationMs: 0,
          failure: { symptom: "runner_error" }
        }))
      )
    );
  } else {
    runs = [];
    for (const adapter of adapters) {
      process.stdout.write(`  Running ${adapter.displayName}... `);
      try {
        const result = await runner.run(task, adapter);
        runs.push(result);
        console.log(result.status === "pass" ? "PASS" : "FAIL");
      } catch (err) {
        console.log("ERROR");
        console.error(`    ${err.message}`);
        runs.push({
          agentId: adapter.id,
          status: "error",
          error: err.message,
          evaluation: { score: 0, failToPassRate: 0, passToPassRate: 0 },
          metrics: { toolCalls: 0, estimatedCostUsd: 0, patch: { linesAdded: 0, linesRemoved: 0 } },
          durationMs: 0,
          failure: { symptom: "runner_error" }
        });
      }
    }
  }

  console.log("\n" + comparisonTable(runs));

  // Persist comparison JSON
  mkdirSync(runsDir, { recursive: true });
  const compId = `compare_${Date.now()}_${task.id}`;
  const compPath = join(runsDir, `${compId}.json`);
  writeFileSync(compPath, JSON.stringify({ id: compId, taskId: task.id, runs }, null, 2), "utf8");
  console.log(`\nSaved: ${compPath}`);
}

function parseAgentList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}
