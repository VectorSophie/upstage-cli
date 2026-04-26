/**
 * Parses agent definition files into a canonical object:
 * { name, description, model, tools, hooks, prompt }
 */

function extractYamlFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();
  const meta = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();

    // Minimal YAML: handle quoted strings and arrays [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      meta[key] = val.replace(/^["']|["']$/g, "");
    }
  }

  return { meta, body };
}

export function parseAgentDefinition(content, ext) {
  try {
    if (ext === ".json") {
      const def = JSON.parse(content);
      if (!def.name) return null;
      return {
        name: def.name,
        description: def.description || "",
        model: def.model || null,
        tools: Array.isArray(def.tools) ? def.tools : [],
        hooks: def.hooks || {},
        prompt: def.prompt || ""
      };
    }

    if (ext === ".md") {
      const parsed = extractYamlFrontmatter(content);
      if (!parsed) {
        // No frontmatter — treat entire content as prompt, name from content
        return null;
      }
      const { meta, body } = parsed;
      if (!meta.name) return null;
      return {
        name: meta.name,
        description: meta.description || "",
        model: meta.model || null,
        tools: Array.isArray(meta.tools) ? meta.tools : [],
        hooks: {},
        prompt: body
      };
    }
  } catch (_e) {
    // malformed — skip
  }
  return null;
}
