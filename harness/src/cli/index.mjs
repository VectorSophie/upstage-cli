import { runCommand } from "./commands/run.mjs";
import { reportCommand } from "./commands/report.mjs";
import { compareCommand } from "./commands/compare.mjs";
import { replayCommand } from "./commands/replay.mjs";
import { reviewCommand } from "./commands/review.mjs";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        // Accumulate repeated flags (e.g. --agent A --agent B) into arrays
        if (key in options) {
          options[key] = Array.isArray(options[key]) ? [...options[key], next] : [options[key], next];
        } else {
          options[key] = next;
        }
        i += 2;
      } else {
        options[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, options };
}

export async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const rest = positional.slice(1);

  switch (command) {
    case "run":
      await runCommand(rest, options);
      break;
    case "report":
      reportCommand(rest, options);
      break;
    case "compare":
      await compareCommand(rest, options);
      break;
    case "replay":
      await replayCommand(rest, options);
      break;
    case "review":
      await reviewCommand(rest, options);
      break;
    default:
      console.log(`harness — upstage-cli evaluation harness v2.3.0

Commands:
  harness run     <task.yaml> [--agent mock|upstage] [--k N] [--runs-dir ./runs]
  harness compare <task.yaml> --agent A --agent B [--parallel] [--runs-dir ./runs]
  harness report  <run.json> [--jsonl] [--html] [--dashboard]
  harness replay  <run.json> [--stop-at-turn N] [--task task.yaml] [--runs-dir ./runs]
  harness review  <run.json>

Options:
  --agent          Agent to use (default: mock); repeat for compare
  --k              Number of runs for pass@k (default: 1)
  --runs-dir       Directory to save run artifacts (default: runs/)
  --parallel       Run agents in parallel (compare only)
  --jsonl          Output SWE-bench predictions JSONL format
  --html           Output HTML report
  --dashboard      Output multi-run HTML dashboard
  --stop-at-turn   Stop replay after turn N
  --task           Task YAML path for replay (inferred from run if omitted)
`);
      if (command && command !== "help") process.exitCode = 1;
  }
}
