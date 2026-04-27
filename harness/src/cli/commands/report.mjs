import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toMarkdown, toPredictionsJsonl } from "../../report/generator.mjs";

export function reportCommand(argv, options = {}) {
  const runPath = argv[0];
  if (!runPath) {
    console.error("Usage: harness report <run.json> [--jsonl]");
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

  if (options.jsonl) {
    console.log(toPredictionsJsonl([run]));
  } else {
    console.log(toMarkdown(run));
  }
}
