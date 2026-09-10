// `upstage context` — Task 7.15 of the 3.2.0 release plan.
//
// A repo-level context budget report: where a FRESH session's context
// window would go before the first prompt is even sent — project
// instructions (UPSTAGE.md/AGENTS.md), repo map, a system-prompt baseline,
// and builtin/MCP tool schema cost — against the resolved model's context
// limit. No session is started and no model call is made.
//
// The actual computation lives in src/agent/context-budget.mjs
// (computeContextBudget()), shared with the TUI's `/context` (src/ui/
// commands.mjs) so the two surfaces — and /compact's/`/cost`'s own numbers —
// can never disagree about what a token "is".

import { computeContextBudget } from "../../agent/context-budget.mjs";

const CATEGORY_ROWS = [
  ["systemPromptTokens", "System prompt"],
  ["toolsTokens", "Builtin tools"],
  ["mcpTokens", "MCP tools"],
  ["projectInstructionsTokens", "Project instructions"],
  ["skillsTokens", "Skills"],
  ["repoMapTokens", "Repo map"]
];

function printUsage() {
  process.stdout.write(
    [
      "Usage: upstage context [--json]",
      "",
      "  Reports a repo-level context budget: project instructions (UPSTAGE.md/",
      "  AGENTS.md), repo map, a system-prompt baseline, and builtin/MCP tool",
      "  schema cost, against the resolved model's context limit. Computed",
      "  without starting a session or making a model call.",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

function pct(part, total) {
  if (!total) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function formatContextBudgetHuman(budget) {
  const total = CATEGORY_ROWS.reduce((sum, [key]) => sum + (budget[key] || 0), 0);
  const lines = CATEGORY_ROWS.map(([key, label]) => {
    const tokens = budget[key] || 0;
    return `  ${label.padEnd(22)} ${String(tokens).padStart(10)} tokens  (${pct(tokens, budget.contextLimit)})`;
  });
  lines.push("");
  lines.push(`  ${"Total".padEnd(22)} ${String(total).padStart(10)} tokens  (${pct(total, budget.contextLimit)})`);
  lines.push(`  Context limit: ${budget.contextLimit.toLocaleString()} tokens`);
  return lines.join("\n") + "\n";
}

export function formatContextBudgetJson(budget) {
  return `${JSON.stringify(budget, null, 2)}\n`;
}

export async function runContextCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage();
    return 0;
  }
  const json = rest.includes("--json");
  try {
    const budget = await computeContextBudget({ cwd: process.cwd() });
    process.stdout.write(json ? formatContextBudgetJson(budget) : formatContextBudgetHuman(budget));
    return 0;
  } catch (err) {
    process.stderr.write(`upstage context: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
