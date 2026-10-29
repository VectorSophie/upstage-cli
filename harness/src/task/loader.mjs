import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, extname, basename } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { validate, resolveImport } from "./schema.mjs";
import { resolveMountAsset } from "../sandbox/mount-registry.mjs";

export function loadTask(taskPath) {
  const absPath = resolve(taskPath);
  const taskDir = dirname(absPath);
  const raw = yamlLoad(readFileSync(absPath, "utf8"));
  const spec = resolveImport(raw, absPath);
  // Resolve a local repo path relative to the task file's directory. Remote
  // identifiers (github:owner/name) are left as-is; the runner rejects them
  // with instructions rather than treating them as a local path.
  if (typeof spec.repo === "string" && spec.repo && !isRemoteRepo(spec.repo)) {
    spec.repo = resolve(taskDir, spec.repo);
  }
  // Read-only mounts are referenced by NAME from the trusted harness registry
  // (src/sandbox/mount-registry.mjs). A task may NOT supply host/container paths
  // — authorization lives in harness code, not untrusted task YAML, so a task
  // cannot mount arbitrary host files or expand its own permissions. Unknown
  // assets (or any attempt to pass a raw path) are rejected here, fail-closed,
  // before any sandbox is built.
  if (spec.sandbox?.readonlyMounts !== undefined) {
    if (!Array.isArray(spec.sandbox.readonlyMounts)) {
      throw new Error(`Invalid task spec at ${absPath}: sandbox.readonlyMounts must be a list`);
    }
    spec.sandbox.readonlyMounts = spec.sandbox.readonlyMounts.map((m) => {
      if (!m || typeof m.asset !== "string" || m.asset.trim() === "") {
        throw new Error(`Invalid task spec at ${absPath}: each sandbox.readonlyMounts entry must be { asset: <name> } referencing a trusted registry asset`);
      }
      if (m.host !== undefined || m.container !== undefined) {
        throw new Error(`Invalid task spec at ${absPath}: sandbox.readonlyMounts may not specify host/container paths; reference a trusted asset by name`);
      }
      return resolveMountAsset(m.asset); // → { host, container }, canonicalised + allowlisted
    });
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
      throw new Error(`Failed to load task ${entry}: ${msg}`, { cause: err });
    }
  }
  return tasks;
}

export function isRemoteRepo(repo) {
  return /^(github:|https?:\/\/|git@)/.test(repo);
}
