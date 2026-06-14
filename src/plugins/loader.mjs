import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import os from "node:os";
import { parseAgentDefinition } from "../agents/parser.mjs";

/**
 * PluginLoader — discovers Claude-Code-compatible plugins and aggregates their
 * components so upstage-cli inherits the plugin ecosystem.
 *
 * A plugin is a directory containing `.claude-plugin/plugin.json` plus any of:
 *   commands/      *.md            → slash commands
 *   agents/        *.md|*.json      → subagent definitions
 *   skills/<name>/ SKILL.md         → skills
 *   hooks/         hooks.json       → settings-shaped hook map
 *   .mcp.json                       → MCP servers
 *
 * Discovered under: <cwd>/.claude/plugins, <cwd>/.upstage/plugins, and the same
 * two under the home directory.
 */

const PLUGIN_ROOTS = (cwd) => [
  join(cwd, ".claude", "plugins"),
  join(cwd, ".upstage", "plugins"),
  join(os.homedir(), ".claude", "plugins"),
  join(os.homedir(), ".upstage", "plugins")
];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2].trim() };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function loadCommands(dir, pluginName) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== ".md") continue;
    const content = await readFile(join(dir, entry.name), "utf8").catch(() => null);
    if (content == null) continue;
    const { meta, body } = parseFrontmatter(content);
    const name = `/${basename(entry.name, ".md")}`;
    out.push({ name, description: meta.description || `${name} (plugin: ${pluginName})`, body, plugin: pluginName });
  }
  return out;
}

async function loadAgents(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".md" && ext !== ".json") continue;
    const content = await readFile(join(dir, entry.name), "utf8").catch(() => null);
    if (content == null) continue;
    const def = parseAgentDefinition(content, ext);
    if (def) out.push(def);
  }
  return out;
}

async function loadSkills(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    const content = await readFile(mdPath, "utf8").catch(() => null);
    if (content == null) continue;
    const { meta, body } = parseFrontmatter(content);
    out.push({ name: meta.name || entry.name, description: meta.description || "", prompt: body });
  }
  return out;
}

export class PluginLoader {
  constructor() {
    this.plugins = [];     // [{ name, version, dir }]
    this.commands = [];    // [{ name, description, body, plugin }]
    this.agents = [];      // canonical agent defs
    this.skills = [];      // [{ name, description, prompt }]
    this.hooks = {};       // EventName → [hookDef]
    this.mcpServers = {};  // name → server config
  }

  async load(cwd = process.cwd()) {
    for (const root of PLUGIN_ROOTS(cwd)) {
      if (!existsSync(root)) continue;
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await this._loadPlugin(join(root, entry.name));
      }
    }
    return this;
  }

  async _loadPlugin(dir) {
    const manifest = await readJson(join(dir, ".claude-plugin", "plugin.json"));
    if (!manifest) return; // not a plugin
    const name = manifest.name || basename(dir);
    if (this.plugins.some((p) => p.name === name)) return; // first wins
    this.plugins.push({ name, version: manifest.version || "0.0.0", dir });

    this.commands.push(...await loadCommands(join(dir, "commands"), name));
    this.agents.push(...await loadAgents(join(dir, "agents")));
    this.skills.push(...await loadSkills(join(dir, "skills")));

    // Hooks: hooks/hooks.json or a `hooks` field in plugin.json.
    const hookMap = (await readJson(join(dir, "hooks", "hooks.json"))) || manifest.hooks || null;
    if (hookMap && typeof hookMap === "object") {
      for (const [event, defs] of Object.entries(hookMap)) {
        if (!Array.isArray(defs)) continue;
        this.hooks[event] = (this.hooks[event] || []).concat(defs);
      }
    }

    // MCP servers from the plugin's .mcp.json.
    const mcp = await readJson(join(dir, ".mcp.json"));
    if (mcp?.mcpServers && typeof mcp.mcpServers === "object") {
      for (const [serverName, def] of Object.entries(mcp.mcpServers)) {
        if (!(serverName in this.mcpServers)) this.mcpServers[serverName] = def;
      }
    }
  }

  list() {
    return this.plugins.map((p) => ({ name: p.name, version: p.version }));
  }
}
