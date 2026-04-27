import { runCommand } from "./commands/run.mjs";
import { reportCommand } from "./commands/report.mjs";

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
        options[key] = next;
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
    default:
      console.log(`harness — upstage-cli evaluation harness v2.0.0

Commands:
  harness run <task.yaml> [--agent mock|upstage] [--k N] [--runs-dir ./runs]
  harness report <run.json> [--jsonl]

Options:
  --agent     Agent to use (default: mock)
  --k         Number of runs for pass@k (default: 1)
  --runs-dir  Directory to save run artifacts (default: runs/)
  --jsonl     Output SWE-bench predictions JSONL format
`);
      if (command && command !== "help") process.exitCode = 1;
  }
}
