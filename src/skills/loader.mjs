import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// Package-bundled first-party skills (docs/skills-research-aug2026.md) ship
// at <repo root>/skills/, sibling to src/ — same relationship builtin tools
// have to the package root. Always available regardless of cwd, distinct
// from project-local skills below. .claude/skills/ is Agent-Skills-format
// interop: picks up any repo's existing skills for free (e.g. `npx skills
// add NomaDamas/k-skill --all -g`), a different convention from
// PluginLoader's .claude/plugins/*/skills/ marketplace layout.
// "First seen wins" (see load() below) — project-local dirs are listed
// before the bundled pack so a project can override a first-party skill,
// and both come before the global (~) dir.
const PACKAGE_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

const SEARCH_DIRS = (cwd) => [
  join(cwd, ".upstage", "skills"),
  join(cwd, ".claude", "skills"),
  PACKAGE_SKILLS_DIR,
  // A `bun build --compile` standalone executable has no real on-disk
  // location for import.meta.url (it resolves inside a virtual $bunfs
  // root), so PACKAGE_SKILLS_DIR above silently resolves to nothing there
  // — this is the compiled-binary equivalent: a `skills/` dir shipped
  // alongside the executable itself (the release tarball's layout), found
  // via the one path that IS real in that mode, process.execPath. Computed
  // per-call (not a module-level const) so it reflects the current
  // process.execPath rather than whatever it was at first import.
  join(dirname(process.execPath), "skills"),
  join(os.homedir(), ".upstage", "skills"),
];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const lines = match[1].split(/\r?\n/);
  const meta = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1].trim();
    const val = kv[2].trim();

    // Block scalar (`>` folds into spaces, `|` preserves newlines) — the
    // one addition beyond the original flat-scalar/bracket-list parser,
    // needed for skill descriptions long enough to wrap across lines.
    if (val === ">" || val === "|") {
      const blockLines = [];
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^\s+/.test(lines[i]))) {
        blockLines.push(lines[i].replace(/^ {1,2}/, ""));
        i++;
      }
      meta[key] = (val === "|" ? blockLines.join("\n") : blockLines.join(" ")).trim();
      continue;
    }

    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      meta[key] = val.replace(/^["']|["']$/g, "");
    }
    i++;
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
              license: meta.license || null,
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
    return Array.from(this.skills.values()).map(({ name, description, aliases, license }) => ({
      name, description, aliases, license
    }));
  }

  run(name, args = "") {
    const skill = this.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    const prompt = skill.prompt.replace(/\$ARGUMENTS/g, args);
    return `[Skill: ${skill.name}]\n\n${prompt}`;
  }
}
