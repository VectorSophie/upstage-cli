// `upstage plugins list/show` — Task 12.5 of the 3.2.0 release plan.
//
// Thin wrapper over `PluginLoader` (src/plugins/loader.mjs). Its real
// surface, read directly from that file:
//   `load(cwd)`  → populates the loader, returns `this`
//   `list()`     → `[{name, version}]` — deliberately narrow (no `dir`)
//   `.plugins`   → the richer backing array, `[{name, version, dir}]`
//   `.commands`  → `[{name, description, body, plugin}]` — the ONLY
//                  component PluginLoader tracks per-plugin ownership for
//   `.agents` / `.skills` — aggregated across ALL plugins with no owning-
//                  plugin field, so a per-plugin agent/skill count can't be
//                  attributed accurately here without re-parsing that one
//                  plugin's directory a second time; `show` below reports
//                  what's genuinely attributable (name/version/dir/commands)
//                  rather than fabricating a count.
//   `.hooks` / `.mcpServers` — merged maps, same non-attribution problem.
//
// No CRUD — visibility only, matching the plan's explicit scope note
// ("plugins install" stays a router stub, out of this task).

import { PluginLoader } from "../../plugins/loader.mjs";

async function loadPlugins(cwd) {
  return new PluginLoader().load(cwd);
}

// ── list ─────────────────────────────────────────────────────────────────

/** Returns `[{name, version}]` (PluginLoader.list()'s own shape). Accepts a
 *  pre-loaded `loader` for tests. */
export async function gatherPluginsList({ cwd = process.cwd(), loader } = {}) {
  const l = loader || (await loadPlugins(cwd));
  return l.list();
}

export function formatListHuman(rows) {
  if (rows.length === 0) return "No plugins found.\n";
  return rows.map((p) => `${p.name} (${p.version})`).join("\n") + "\n";
}

export function formatListJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function printListUsage() {
  process.stdout.write(
    [
      "Usage: upstage plugins list [--json]",
      "",
      "Lists every discovered plugin (.claude/plugins/, .upstage/plugins/,",
      "project and home directory).",
      "",
      "Options:",
      "  --json   Output as JSON: [{name, version}]"
    ].join("\n") + "\n"
  );
}

export async function runPluginsListCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printListUsage();
    return 0;
  }
  const json = rest.includes("--json");
  const rows = await gatherPluginsList({ cwd: process.cwd() });
  process.stdout.write(json ? formatListJson(rows) : formatListHuman(rows));
  return 0;
}

// ── show ─────────────────────────────────────────────────────────────────

/** Returns `{ result: {name, version, dir, commands} }` or `{ error, code:
 *  2 }`. `commands` is filtered from the loader's aggregate `.commands` list
 *  by `plugin === name` — the one component PluginLoader tracks ownership
 *  for (see this file's header). */
export async function gatherPluginsShow({ cwd = process.cwd(), loader, name } = {}) {
  if (!name) return { error: "missing required <name> argument", code: 2 };
  const l = loader || (await loadPlugins(cwd));
  const plugin = l.plugins.find((p) => p.name === name);
  if (!plugin) return { error: `no plugin named '${name}' found`, code: 2 };
  const commands = l.commands
    .filter((c) => c.plugin === name)
    .map((c) => ({ name: c.name, description: c.description || "" }));
  return { result: { name: plugin.name, version: plugin.version, dir: plugin.dir, commands } };
}

export function formatShowHuman(shown) {
  const lines = [
    `name: ${shown.name}`,
    `version: ${shown.version}`,
    `dir: ${shown.dir}`,
    "commands:"
  ];
  if (shown.commands.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of shown.commands) {
      lines.push(`  ${c.name}${c.description ? ` — ${c.description}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function formatShowJson(shown) {
  return `${JSON.stringify(shown, null, 2)}\n`;
}

function printShowUsage() {
  process.stdout.write(
    [
      "Usage: upstage plugins show <name> [--json]",
      "",
      "Prints one plugin's version, install directory, and the slash commands",
      "it contributes.",
      "",
      "Options:",
      "  --json   Output as JSON"
    ].join("\n") + "\n"
  );
}

export async function runPluginsShowCommand(rest = []) {
  if (rest.includes("-h") || rest.includes("--help")) {
    printShowUsage();
    return 0;
  }
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const json = rest.includes("--json");
  const name = positionals[0];

  const outcome = await gatherPluginsShow({ cwd: process.cwd(), name });
  if (outcome.error) {
    process.stderr.write(`upstage plugins show: ${outcome.error}\n`);
    return outcome.code;
  }
  process.stdout.write(json ? formatShowJson(outcome.result) : formatShowHuman(outcome.result));
  return 0;
}
