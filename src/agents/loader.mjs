import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import os from "node:os";
import { parseAgentDefinition } from "./parser.mjs";

const SEARCH_DIRS = (cwd) => [
  join(cwd, ".upstage", "agents"),
  join(os.homedir(), ".upstage", "agents"),
];

export class AgentLoader {
  constructor() {
    this.agents = new Map();
  }

  async load(cwd = process.cwd()) {
    this.agents.clear();
    for (const dir of SEARCH_DIRS(cwd)) {
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (_e) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        if (ext !== ".json" && ext !== ".md") continue;
        try {
          const content = await readFile(join(dir, entry.name), "utf8");
          const def = parseAgentDefinition(content, ext);
          if (def && !this.agents.has(def.name)) {
            this.agents.set(def.name, def);
          }
        } catch (_e) {
          // skip unreadable files
        }
      }
    }
    return this;
  }

  get(name) {
    return this.agents.get(name) || null;
  }

  list() {
    return Array.from(this.agents.values());
  }

  has(name) {
    return this.agents.has(name);
  }
}
