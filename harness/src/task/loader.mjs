import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, extname, basename } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { validate, resolveImport } from "./schema.mjs";

export function loadTask(taskPath) {
  const absPath = resolve(taskPath);
  const taskDir = dirname(absPath);
  const raw = yamlLoad(readFileSync(absPath, "utf8"));
  const spec = resolveImport(raw, absPath);
  // Resolve repo relative to the task file's directory
  if (spec.repo && !resolve(spec.repo).startsWith(resolve("/"))) {
    spec.repo = resolve(taskDir, spec.repo);
  } else if (spec.repo) {
    spec.repo = resolve(taskDir, spec.repo);
  }
  const { valid, errors } = validate(spec);
  if (!valid) {
    throw new Error(`Invalid task spec at ${absPath}:\n  ${errors.join("\n  ")}`);
  }
  return spec;
}

export function loadTaskDir(dir) {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir);
  const tasks = [];
  for (const entry of entries) {
    const ext = extname(entry);
    if (ext !== ".yaml" && ext !== ".yml") continue;
    const name = basename(entry, ext);
    if (name.startsWith("_")) continue;
    try {
      const spec = loadTask(resolve(absDir, entry));
      tasks.push(spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load task ${entry}: ${msg}`);
    }
  }
  return tasks;
}
