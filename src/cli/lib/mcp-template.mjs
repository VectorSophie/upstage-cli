// `upstage init --with-browser-mcp` (3.3.0 Thread C, Task C.5) — offers a
// chrome-devtools-mcp entry in .mcp.json for advanced browser debugging
// (performance traces, deep network inspection) beyond what the native
// browser_* tools (Task C.3) cover. Offered, never forced: this module is
// only ever called from init.mjs's explicit --with-browser-mcp branch — no
// browser_* tool or doctor check calls into it. No new MCP client code is
// needed: src/tools/mcp/config.mjs already runs any stdio server named in
// .mcp.json, chrome-devtools-mcp works today via a normal entry.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CHROME_DEVTOOLS_ENTRY = { command: "npx", args: ["chrome-devtools-mcp@latest"] };

/** Adds a `"chrome-devtools"` stdio server entry to `<cwd>/.mcp.json`,
 *  creating the file if it doesn't exist and preserving every other entry
 *  if it does. Idempotent — returns `{action: "already-present"}` without
 *  writing anything if the entry is already there. */
export async function addChromeDevtoolsMcpEntry(cwd = process.cwd()) {
  const path = join(cwd, ".mcp.json");

  let config;
  let existed = false;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
    existed = true;
  } catch {
    config = {};
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  if (config.mcpServers["chrome-devtools"]) {
    return { action: "already-present", path };
  }

  config.mcpServers["chrome-devtools"] = CHROME_DEVTOOLS_ENTRY;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { action: existed ? "updated" : "created", path };
}
