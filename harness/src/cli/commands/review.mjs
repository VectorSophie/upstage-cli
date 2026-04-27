import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promptReview } from "../../evaluation/human-review.mjs";

export async function reviewCommand(argv, options = {}) {
  const runPath = argv[0];
  if (!runPath) {
    console.error("Usage: harness review <run.json>");
    process.exitCode = 1;
    return;
  }

  const absPath = resolve(runPath);
  let run;
  try {
    run = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read run file: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (run.humanReview) {
    const prev = new Date(run.humanReview.reviewedAt).toLocaleString();
    console.log(`Note: run already has a human review from ${prev}.`);
    console.log("Proceeding will overwrite it.\n");
  }

  const review = await promptReview(run);
  run.humanReview = review;

  try {
    writeFileSync(absPath, JSON.stringify(run, null, 2), "utf8");
    console.log(`\nReview saved to ${absPath}`);
    if (review.averageScore !== null) {
      console.log(`Average score: ${review.averageScore}/5`);
    }
  } catch (err) {
    console.error(`Failed to save review: ${err.message}`);
    process.exitCode = 1;
  }
}
