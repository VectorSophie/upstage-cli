// `upstage tools list/show` — Task 12.5 of the 3.2.0 release plan.
//
// Thin introspection layer over `ToolRegistry` (src/tools/registry.mjs):
// `list` groups/sorts every registered tool by source, `show` prints one
// tool's full schema/description/source. No CRUD — visibility only, per the
// plan's explicit scope note (tools/agents/plugins get no install/create/
// delete commands; only `skills install` exists, from Task 7.9).
//
// REGISTRY CONSTRUCTION: `buildFullToolRegistry()` below reuses the exact
// same primitives doctor.mjs's `gatherMcpStatus()` (Task 12.3) already uses
// to build a "fully populated" registry for its Extensions section —
// `loadMcpServerConfigs` + `connectConfiguredServers` (same 5s connect
// timeout constant/reasoning) feeding `createRegistryWithExtensions`. Unlike
// doctor, THIS command also wires up tool discovery
// (UPSTAGE_DISCOVERY_COMMAND / UPSTAGE_DISCOVERY_INVOKE_COMMAND, resolved via
// the shared `discoveryConfigFromEnv()` in src/tools/create-registry.mjs —
// the same helper src/cli/index.mjs's session wiring and
// context-budget.mjs's computeContextBudget() both call, so all three never
// disagree about what "discovery is configured" means) — doctor deliberately
// skips invoking discovery (presence-only check, see its
// own comment), but `tools list`'s entire job IS "list every active tool",
// so silently omitting discovered tools here would make the command
// misleading for anyone who has that env var configured. A misbehaving
// discovery command (bad JSON, non-zero exit, ...) is caught and degrades
// to builtin+MCP only rather than crashing the whole command — same
// "best-effort enrichment, connection results still stand" precedent
// doctor's `gatherMcpStatus` established.
//
// SOURCE TAGS: verified directly against the registration code (registry.mjs,
// mcp-tool.mjs, discovery/discovered-tool.mjs) rather than assumed — the
// only source tags that exist anywhere in this codebase are "builtin",
// "mcp", and "discovered". There is NO separate "plugin" tag: a plugin's own
// `.mcp.json` servers are merged into the same `mcpServers` config as
// directly-configured ones (see src/cli/index.mjs's
// `{ ...pluginLoader.mcpServers, ...settings.mcpServers }` merge) and end up
// registered exactly like any other MCP server, tagged source:"mcp" — a
// plugin-sourced tool is indistinguishable from a directly-configured MCP
// tool at the registry level. The plan's own "BUILTIN|MCP|PLUGIN|DISCOVERED"
// list was accordingly speculative; this file only ever displays the three
// tags that are real. `displaySource()` still upper-cases whatever tag it's
// given, so an actual future "plugin" tag would render correctly without
// code changes here.
//
// TESTABILITY: every `gather*` function accepts an optional pre-built
// `registry` (bypassing `buildFullToolRegistry()` entirely) — the primary
// test seam for "includes an MCP-sourced and a discovered-sourced tool"
// (Task 12.5's acceptance criteria): tests construct a registry directly via
// `createRegistry()` + `.register()` with fixture tool objects shaped like
// `createMcpTool`/`createDiscoveredTool`'s real output, rather than spinning
// up real stdio/http MCP servers or discovery subprocesses for every case
// (tests/m33-cli-mcp.test.mjs already covers that heavier integration path
// for the MCP primitives themselves).

import { createRegistryWithExtensions, discoveryConfigFromEnv } from "../../tools/create-registry.mjs";
import { loadMcpServerConfigs, connectConfiguredServers } from "../../tools/mcp/config.mjs";
import { loadSettings } from "../../config/settings.mjs";
import { DEFAULT_POLICY } from "../../config/defaults.mjs";

// Same value/reasoning as doctor.mjs's MCP_CHECK_TIMEOUT_MS and mcp.mjs's
// CONNECT_TIMEOUT_MS — an introspection command must never hang on a
// misbehaving MCP server.
const MCP_CONNECT_TIMEOUT_MS = 5000;

/** Builds a registry with builtin + connected-MCP + discovered tools, all
 *  best-effort (a failed MCP server or a broken discovery command degrades
 *  the result rather than throwing). Exported for tests that want the real
 *  wiring rather than a hand-built fixture registry. */
export async function buildFullToolRegistry({ cwd = process.cwd(), settings } = {}) {
  const resolvedSettings = settings || (await loadSettings({ cwd }));
  const configs = await loadMcpServerConfigs(cwd, resolvedSettings, { onLog: () => {} });
  const { servers, closeAll } = await connectConfiguredServers(configs, {
    cwd,
    timeoutMs: MCP_CONNECT_TIMEOUT_MS,
    onLog: () => {}
  });
  const discovery = discoveryConfigFromEnv({ cwd });

  let registry;
  try {
    registry = await createRegistryWithExtensions({ policy: DEFAULT_POLICY, cwd, discovery, mcpServers: servers });
  } catch {
    // Discovery blew up (bad JSON / non-zero exit / etc.) — degrade to
    // builtin + whatever MCP servers connected, reusing the exact same
    // (already-tested) construction path minus `discovery`, rather than
    // losing the whole registry over one broken external command.
    registry = await createRegistryWithExtensions({ policy: DEFAULT_POLICY, cwd, mcpServers: servers });
  } finally {
    await closeAll().catch(() => {});
  }
  return registry;
}

// ── source display ──────────────────────────────────────────────────────

const SOURCE_DISPLAY = { builtin: "BUILTIN", mcp: "MCP", discovered: "DISCOVERED" };

function displaySource(source) {
  return SOURCE_DISPLAY[source] || String(source || "unknown").toUpperCase();
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `[{name, source, risk, description}]`, grouped/sorted by source
 *  (ToolRegistry.sortedList()'s own order: builtin, discovered, mcp, then
 *  anything else, each group name-sorted). Raw (lowercase) source tags —
 *  uppercasing is display-only, done in `formatListHuman`. */
export async function gatherToolsList({ cwd = process.cwd(), settings, registry } = {}) {
  const reg = registry || (await buildFullToolRegistry({ cwd, settings }));
  return reg.sortedList().map((tool) => ({
    name: tool.name,
    source: tool.source,
    risk: tool.risk,
    description: tool.description || ""
  }));
}

export function formatListHuman(rows) {
  if (rows.length === 0) return "No tools registered.\n";
  const lines = [];
  let lastSource = null;
  for (const row of rows) {
    if (row.source !== lastSource) {
      if (lastSource !== null) lines.push("");
      lines.push(`${displaySource(row.source)}`);
      lastSource = row.source;
    }
    const desc = row.description ? ` — ${row.description}` : "";
    lines.push(`  ${row.name}${desc}`);
  }
  return lines.join("\n") + "\n";
}

export function formatListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage tools list [--json]",
      "",
      "Lists every registered tool (builtin + connected MCP servers +",
      "discovered tools), grouped and sorted by source.",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, source, risk, description}]"
    ].join("\n") + "\n"
  );
}

export async function runToolsListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const json = rest.includes("--json");
  const rows = await gatherToolsList({ cwd: process.cwd() });
  process.stdout.write(json ? formatListJson(rows) : formatListHuman(rows));
  return 0;
}

// ── show ─────────────────────────────────────────────────────────────────

/** Returns `{ result: <full tool record> }` or `{ error, code: 2 }` (a
 *  missing/unknown name is always a usage error — `show` never has a
 *  network-failure code path of its own, unlike `mcp tools`/`mcp test`). */
export async function gatherToolsShow({ cwd = process.cwd(), settings, registry, name } = {}) {
  if (!name) return { error: "missing required <name> argument", code: 2 };
  const reg = registry || (await buildFullToolRegistry({ cwd, settings }));
  const tool = reg.get(name);
  if (!tool) return { error: `no tool named '${name}' registered`, code: 2 };
  return {
    result: {
      name: tool.name,
      source: tool.source,
      risk: tool.risk,
      actionClass: tool.actionClass,
      description: tool.description || "",
      permissions: tool.permissions || [],
      timeoutMs: tool.timeoutMs,
      outputBudget: tool.outputBudget,
      inputSchema: tool.inputSchema
    }
  };
}

export function formatShowHuman(shown) {
  const lines = [
    `name: ${shown.name}`,
    `source: ${displaySource(shown.source)}`,
    `risk: ${shown.risk}`,
    `actionClass: ${shown.actionClass ?? "(none)"}`,
    `description: ${shown.description || "(none)"}`,
    `permissions: ${shown.permissions.length > 0 ? shown.permissions.join(", ") : "(none)"}`,
    `timeoutMs: ${shown.timeoutMs}`,
    `outputBudget: ${shown.outputBudget}`,
    "inputSchema:",
    ...JSON.stringify(shown.inputSchema, null, 2).split("\n").map((l) => `  ${l}`)
  ];
  return lines.join("\n") + "\n";
}

export function formatShowJson(shown) {
  return `${JSON.stringify(shown, null, 2)}\n`;
}

function printShowUsage() {
  process.stdout.write(
    [
      "Usage: upstage tools show <name> [--json]",
      "",
      "Prints one tool's full schema/description/source.",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

export async function runToolsShowCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printShowUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const name = positionals[0];

  const outcome = await gatherToolsShow({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage tools show: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatShowJson(outcome.result) : formatShowHuman(outcome.result));
  return 0;
}
