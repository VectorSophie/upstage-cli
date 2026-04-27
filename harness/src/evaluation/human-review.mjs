import { createInterface } from "node:readline";

const DIMENSIONS = [
  { key: "correctness",     label: "Correctness",     hint: "Does the fix actually solve the problem?" },
  { key: "maintainability", label: "Maintainability", hint: "Is the code readable and well-structured?" },
  { key: "minimality",      label: "Minimality",      hint: "Is the patch as small as it reasonably can be?" },
  { key: "security",        label: "Security",        hint: "Does the fix avoid introducing vulnerabilities?" },
  { key: "styleFit",        label: "Style fit",       hint: "Does the code match the surrounding style?" }
];

/**
 * Prompts a human reviewer to score a run on 5 dimensions (1-5 each).
 * Returns the humanReview object to append to run.humanReview.
 */
export async function promptReview(run, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: false });

  output.write(`\n=== Human Review: ${run.taskId} (${run.agentId}) ===\n`);
  output.write(`Status: ${run.status}  Score: ${Math.round((run.evaluation?.score || 0) * 100)}/100\n`);
  output.write(`Rate each dimension 1 (poor) – 5 (excellent). Enter to skip.\n\n`);

  const scores = {};
  const comments = {};

  for (const dim of DIMENSIONS) {
    const score = await askScore(rl, output, dim);
    scores[dim.key] = score;
  }

  const overallComment = await askLine(rl, output, "Overall comment (optional): ");
  if (overallComment.trim()) {
    comments.overall = overallComment.trim();
  }

  rl.close();

  const totalScored = Object.values(scores).filter((s) => s !== null).length;
  const avg = totalScored > 0
    ? Object.values(scores).filter((s) => s !== null).reduce((a, b) => a + b, 0) / totalScored
    : null;

  return {
    reviewedAt: new Date().toISOString(),
    scores,
    comments,
    averageScore: avg !== null ? Math.round(avg * 10) / 10 : null
  };
}

async function askScore(rl, output, dim) {
  output.write(`${dim.label} — ${dim.hint}\n`);
  while (true) {
    const answer = await askLine(rl, output, `  Score [1-5] or Enter to skip: `);
    if (answer.trim() === "") return null;
    const n = parseInt(answer.trim(), 10);
    if (n >= 1 && n <= 5) return n;
    output.write("  Please enter 1–5.\n");
  }
}

function askLine(rl, output, prompt) {
  return new Promise((resolve) => {
    output.write(prompt);
    rl.once("line", (line) => resolve(line));
  });
}
