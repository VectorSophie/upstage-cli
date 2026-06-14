import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StdioMcpClient } from "./stdio-client.mjs";
import { HttpMcpClient } from "./http-client.mjs";

/**
 * Claude-Code-compatible MCP configuration.
 *
 * Reads `mcpServers` from a project `.mcp.json` and/or the settings cascade and
 * connects each one, returning `[{ name, client }]` ready for
 * `createRegistryWithExtensions({ mcpServers })`.
 *
 * Two transports are supported:
 *   stdio: { "<name>": { "command": "npx", "args": [...], "env": {...} } }
 *   http:  { "<name>": { "url": "https://host/mcp", "headers": {...} } }
 *          (Streamable HTTP; `type: "http"|"sse"` are also recognized)
 */

function warn(onLog, message) {
  if (typeof onLog === "function") onLog(message);
  else process.stderr.write(`[mcp] ${message}\n`);
}

async function readMcpJson(cwd) {
  const path = join(cwd, ".mcp.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    warn(null, `failed to read .mcp.json: ${err.message}`);
    return {};
  }
}

/**
 * Merge MCP server definitions from `.mcp.json` (project) and settings.
 * Settings take precedence on name collisions. Returns normalized stdio configs.
 */
export async function loadMcpServerConfigs(cwd = process.cwd(), settings = {}, { onLog } = {}) {
  const fromFile = await readMcpJson(cwd);
  const fromSettings = settings?.mcpServers && typeof settings.mcpServers === "object" ? settings.mcpServers : {};
  const merged = { ...fromFile, ...fromSettings };

  const configs = [];
  for (const [name, def] of Object.entries(merged)) {
    if (!def || typeof def !== "object") continue;

    const isRemote = typeof def.url === "string" || def.type === "http" || def.type === "sse";
    if (isRemote) {
      if (typeof def.url !== "string" || def.url.length === 0) {
        warn(onLog, `server '${name}' is remote but has no 'url' — skipping`);
        continue;
      }
      configs.push({
        name,
        transport: "http",
        url: def.url,
        headers: def.headers && typeof def.headers === "object" ? def.headers : {}
      });
      continue;
    }
    if (typeof def.command !== "string" || def.command.length === 0) {
      warn(onLog, `server '${name}' has no 'command' — skipping`);
      continue;
    }
    configs.push({
      name,
      transport: "stdio",
      command: def.command,
      args: Array.isArray(def.args) ? def.args : [],
      env: def.env && typeof def.env === "object" ? def.env : {}
    });
  }
  return configs;
}

function buildClient(cfg, { cwd, timeoutMs }) {
  if (cfg.transport === "http") {
    return new HttpMcpClient({ url: cfg.url, headers: cfg.headers, name: cfg.name, timeoutMs });
  }
  return new StdioMcpClient({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd,
    name: cfg.name,
    timeoutMs
  });
}

/**
 * Connect each configured server (stdio or http). Failures are isolated: a
 * server that won't start/connect is logged and skipped, never crashing the
 * host. Returns `[{ name, client }]` plus a `closeAll()` for shutdown.
 */
export async function connectConfiguredServers(configs, { cwd, onLog, timeoutMs } = {}) {
  const servers = [];
  for (const cfg of configs) {
    const client = buildClient(cfg, { cwd, timeoutMs });
    try {
      await client.connect();
      servers.push({ name: cfg.name, client });
    } catch (err) {
      warn(onLog, `could not connect server '${cfg.name}': ${err.message}`);
      await client.close().catch(() => {});
    }
  }

  const closeAll = async () => {
    await Promise.all(servers.map((s) => s.client.close().catch(() => {})));
  };
  return { servers, closeAll };
}
