import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReplayEngine } from "../../replay/engine.mjs";
import { TaskRunner } from "../../task/runner.mjs";
import { loadTask } from "../../task/loader.mjs";
import { toMarkdown } from "../../report/generator.mjs";

export async function replayCommand(argv, options = {}) {
  const runPath = argv[0];
  if (!runPath) {
    console.error("Usage: harness replay <run.json> [--stop-at-turn N] [--task task.yaml] [--runs-dir ./runs]");
    process.exitCode = 1;
    return;
  }

  let run;
  try {
    run = JSON.parse(readFileSync(resolve(runPath), "utf8"));
  } catch (err) {
    console.error(`Failed to read run file: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const stopAtTurn = options["stop-at-turn"] ? parseInt(options["stop-at-turn"], 10) : null;
  const runsDir = resolve(options["runs-dir"] || options.runsDir || "runs");

  // Load task — either from --task flag or try the taskId relative to tasks/
  let task;
  const taskPath = options.task
    ? resolve(options.task)
    : resolve(`tasks/${run.taskId}.yaml`);
  try {
    task = loadTask(taskPath);
  } catch (err) {
    console.error(`Cannot load task for replay: ${err.message}\nProvide --task <path> to specify it.`);
    process.exitCode = 1;
    return;
  }

  const engine = new ReplayEngine(run);
  if (stopAtTurn !== null) engine.setStopAtTurn(stopAtTurn);

  console.log(`Replaying run: ${run.id}`);
  console.log(`Task: ${task.id}${stopAtTurn !== null ? `  stop-at-turn: ${stopAtTurn}` : ""}\n`);

  const runner = new TaskRunner({ runsDir });
  const result = await engine.replay(task, runner);

  console.log(toMarkdown(result));

  const divs = engine.divergences;
  if (divs.length > 0) {
    console.log(`\nDivergences detected: ${divs.length}`);
    for (const d of divs) {
      console.log(`  turn ${d.turn}: expected tool '${d.expected}' got '${d.actual}'`);
    }
  } else {
    console.log("\nNo divergences detected.");
  }
}
