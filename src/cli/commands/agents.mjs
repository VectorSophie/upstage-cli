// `upstage agents list/show` — Task 12.5 of the 3.2.0 release plan.
//
// Thin wrapper over `AgentLoader` (src/agents/loader.mjs), whose real method
// names — verified by reading that file directly, per this task's own
// failure-mode warning not to assume they mirror `SkillsLoader`'s — are:
//   `load(cwd)`  → populates the loader, returns `this`
//   `get(name)`  → one agent def or `null`
//   `list()`     → every loaded agent def, as an array
//   `has(name)`  → boolean
// (identical names to SkillsLoader as it turns out, but confirmed rather
// than assumed). An agent def is `{ name, description, model, tools, hooks,
// prompt }` (src/agents/parser.mjs's canonical shape).
//
// No CRUD — visibility only, matching the plan's explicit scope note.

import { AgentLoader } from "../../agents/loader.mjs";

async function loadAgents(cwd) {
  return new AgentLoader().load(cwd);
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `[{name, description, model, tools}]`. Accepts a pre-loaded
 *  `loader` for tests (bypassing real filesystem search dirs). */
export async function gatherAgentsList({ cwd = process.cwd(), loader } = {}) {
  const l = loader || (await loadAgents(cwd));
  return l.list().map((agent) => ({
    name: agent.name,
    description: agent.description || "",
    model: agent.model || null,
    tools: Array.isArray(agent.tools) ? agent.tools : []
  }));
}

export function formatListHuman(rows) {
  if (rows.length === 0) return "No agents found.\n";
  return rows
    .map((a) => {
      const model = a.model ? ` (${a.model})` : "";
      const desc = a.description ? ` — ${a.description}` : "";
      return `${a.name}${model}${desc}`;
    })
    .join("\n") + "\n";
}

export function formatListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage agents list [--json]",
      "",
      "Lists every agent definition found under .upstage/agents/ (project and",
      "home directory).",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, description, model, tools}]"
    ].join("\n") + "\n"
  );
}

export async function runAgentsListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const json = rest.includes("--json");
  const rows = await gatherAgentsList({ cwd: process.cwd() });
  process.stdout.write(json ? formatListJson(rows) : formatListHuman(rows));
  return 0;
}

// ── show ─────────────────────────────────────────────────────────────────

/** Returns `{ result: <full agent def> }` or `{ error, code: 2 }`. */
export async function gatherAgentsShow({ cwd = process.cwd(), loader, name } = {}) {
  if (!name) return { error: "missing required <name> argument", code: 2 };
  const l = loader || (await loadAgents(cwd));
  const agent = l.get(name);
  if (!agent) return { error: `no agent named '${name}' found`, code: 2 };
  return { result: agent };
}

export function formatShowHuman(agent) {
  const tools = Array.isArray(agent.tools) && agent.tools.length > 0 ? agent.tools.join(", ") : "(all)";
  const lines = [
    `name: ${agent.name}`,
    `model: ${agent.model || "(default)"}`,
    `description: ${agent.description || "(none)"}`,
    `tools: ${tools}`,
    "prompt:",
    agent.prompt || "(none)"
  ];
  return lines.join("\n") + "\n";
}

export function formatShowJson(agent) {
  return `${JSON.stringify(agent, null, 2)}\n`;
}

function printShowUsage() {
  process.stdout.write(
    [
      "Usage: upstage agents show <name> [--json]",
      "",
      "Prints one agent definition's full detail (description/model/tools/prompt).",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

export async function runAgentsShowCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printShowUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const name = positionals[0];

  const outcome = await gatherAgentsShow({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage agents show: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatShowJson(outcome.result) : formatShowHuman(outcome.result));
  return 0;
}
