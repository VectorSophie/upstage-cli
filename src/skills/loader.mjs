import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const SEARCH_DIRS = (cwd) => [
  join(cwd, ".upstage", "skills"),
  join(os.homedir(), ".upstage", "skills"),
];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      meta[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: match[2].trim() };
}

export class SkillsLoader {
  constructor() {
    this.skills = new Map();
  }

  async load(cwd = process.cwd()) {
    this.skills.clear();
    for (const dir of SEARCH_DIRS(cwd)) {
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (_e) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const mdPath = join(skillDir, "SKILL.md");
        if (!existsSync(mdPath)) continue;
        try {
          const content = await readFile(mdPath, "utf8");
          const { meta, body } = parseFrontmatter(content);
          const name = meta.name || entry.name;
          if (!this.skills.has(name)) {
            this.skills.set(name, {
              name,
              description: meta.description || "",
              aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
              trigger: meta.trigger || null,
              prompt: body
            });
          }
        } catch (_e) {
          // skip
        }
      }
    }
    return this;
  }

  get(name) {
    if (!name) return null;
    const lower = name.toLowerCase();

    // Exact match
    if (this.skills.has(name)) return this.skills.get(name);
    if (this.skills.has(lower)) return this.skills.get(lower);

    // Prefix match
    for (const [key, skill] of this.skills) {
      if (key.startsWith(lower)) return skill;
    }

    // Alias match
    for (const skill of this.skills.values()) {
      if (skill.aliases.some((a) => a.toLowerCase() === lower)) return skill;
    }

    return null;
  }

  list() {
    return Array.from(this.skills.values()).map(({ name, description, aliases }) => ({
      name, description, aliases
    }));
  }

  run(name, args = "") {
    const skill = this.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    const prompt = skill.prompt.replace(/\$ARGUMENTS/g, args);
    return `[Skill: ${skill.name}]\n\n${prompt}`;
  }
}
