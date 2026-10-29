// External benchmark-pack loader (private held-out datasets).
//
// A pack is a self-contained directory OUTSIDE the public repo, supplied by an
// explicit local path. It holds held-out task YAMLs, their fixtures, and private
// reference solutions, plus a `pack.json` index with content hashes and the
// evaluator version it was authored against. The public repo commits ONLY the
// loader and (optionally) a public summary of hashes + aggregate metadata —
// never the hidden prompts, fixtures, tests, or solutions.
//
// Security posture (all fail-closed):
//   * No auto-discovery — the path is supplied explicitly; nothing is traversed
//     outside it. Every resolved path must stay within the pack root (realpath).
//   * No network, no cloning, no code execution during parsing — pack.json is
//     JSON.parse, task files are YAML parsed by the existing loader. Neither runs
//     pack code.
//   * Task metadata cannot request arbitrary host mounts: read-only mounts are
//     still resolved by NAME from the harness-owned trusted registry (loader.mjs),
//     so a pack cannot mount host files or expand its permissions.
//   * Private reference solutions are NEVER copied into the agent workspace — the
//     TaskRunner copies only `task.repo` (the fixture); solutions live apart and
//     are used only by offline QA.
//   * Content hashes pin INTEGRITY + version, and the evaluator version must
//     match. Hashes DO NOT by themselves guarantee confidentiality (that comes
//     from not committing/exposing the content); this is stated, not overclaimed.
//
// Keep this small: it reuses loadTask, fixtureHash, and the trusted evaluator
// registry. It is NOT a generic plugin system and adds no second runner.

import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { loadTask } from "../task/loader.mjs";
import { getEvaluator } from "../evaluation/evaluators.mjs";
import { fixtureHash } from "./manifest.mjs";

// Bump when the trusted evaluation semantics change; a pack authored against a
// different version is rejected (fail-closed) rather than silently re-scored.
export const PACK_FORMAT_VERSION = "1";
export const EVALUATOR_VERSION = "bench-v1-eval-2";

export class PackError extends Error {
  constructor(message, options) { super(message, options); this.name = "PackError"; }
}

function sha256File(p) { return "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex"); }

/** Resolve a pack-relative path and refuse anything that escapes the pack root. */
function safeResolve(rootReal, rel, label) {
  if (typeof rel !== "string" || rel === "" || rel.startsWith("/") || rel.includes("\0")) {
    throw new PackError(`${label} must be a pack-relative path: ${JSON.stringify(rel)}`);
  }
  const abs = resolve(rootReal, rel);
  let real;
  try { real = realpathSync(abs); } catch { throw new PackError(`${label} not found in pack: ${rel}`); }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new PackError(`${label} resolves outside the pack root (path traversal denied): ${rel}`);
  }
  return real;
}

/**
 * Load and verify an external pack. Returns:
 *   { root, meta, tasks: [taskObj…], solutionDirs: {id→absPath}, summary }
 * `summary` is PUBLIC (ids, families, hashes, check ids) — safe to log/commit.
 * `tasks` carry the actual prompts/fixtures for execution and must NOT be logged.
 */
export function loadPack(packPath, { verifyHashes = true } = {}) {
  if (typeof packPath !== "string" || packPath.trim() === "") throw new PackError("pack path is required");
  let root;
  try { root = realpathSync(resolve(packPath)); } catch { throw new PackError(`pack path does not exist: ${packPath}`); }
  if (!statSync(root).isDirectory()) throw new PackError(`pack path is not a directory: ${packPath}`);

  const indexPath = join(root, "pack.json");
  if (!existsSync(indexPath)) throw new PackError("pack.json not found at the pack root");
  let index;
  try { index = JSON.parse(readFileSync(indexPath, "utf8")); } catch (err) { throw new PackError(`pack.json is not valid JSON: ${err.message}`, { cause: err }); }

  if (index.packFormat !== PACK_FORMAT_VERSION) throw new PackError(`unsupported packFormat '${index.packFormat}' (expected ${PACK_FORMAT_VERSION})`);
  if (index.evaluatorVersion !== EVALUATOR_VERSION) throw new PackError(`pack evaluatorVersion '${index.evaluatorVersion}' != harness ${EVALUATOR_VERSION} — refusing to score a mismatched pack`);
  if (!Array.isArray(index.tasks) || index.tasks.length === 0) throw new PackError("pack.json has no tasks");

  const tasks = [];
  const solutionDirs = {};
  const summary = [];
  const seen = new Set();
  for (const entry of index.tasks) {
    if (!entry || typeof entry.id !== "string" || typeof entry.taskFile !== "string") throw new PackError("each pack task needs string id + taskFile");
    if (seen.has(entry.id)) throw new PackError(`duplicate pack task id: ${entry.id}`);
    seen.add(entry.id);

    const taskPath = safeResolve(root, entry.taskFile, `task '${entry.id}' taskFile`);
    if (verifyHashes) {
      const got = sha256File(taskPath);
      if (got !== entry.taskSha256) throw new PackError(`task '${entry.id}' taskFile hash mismatch (pack ${String(entry.taskSha256).slice(0, 20)}… vs actual ${got.slice(0, 20)}…)`);
    }
    const task = loadTask(taskPath); // validates + resolves mounts by trusted NAME only
    if (task.id !== entry.id) throw new PackError(`pack task id '${entry.id}' != task file id '${task.id}'`);

    // fixture must live inside the pack and match its recorded hash
    const repoReal = realpathSync(resolve(task.repo));
    if (repoReal !== root && !repoReal.startsWith(root + sep)) throw new PackError(`task '${entry.id}' fixture resolves outside the pack root`);
    const fh = fixtureHash(repoReal);
    if (verifyHashes && entry.fixtureHash && fh !== entry.fixtureHash) throw new PackError(`task '${entry.id}' fixture hash mismatch`);

    // acceptance evaluators must be known, harness-owned code
    for (const c of (task.checks.custom || [])) {
      if (c.evaluator && !getEvaluator(c.evaluator)) throw new PackError(`task '${entry.id}' names unknown evaluator '${c.evaluator}'`);
    }
    // private solution dir (optional) — recorded but NEVER copied to the agent
    if (entry.solutionDir) solutionDirs[entry.id] = safeResolve(root, entry.solutionDir, `task '${entry.id}' solutionDir`);

    tasks.push(task);
    summary.push({
      id: entry.id,
      family: entry.family || entry.id,
      category: entry.category || null,
      difficulty: task.difficulty || null,
      split: "holdout",
      language: task.language || "en",
      fixtureHash: fh,
      taskSha256: sha256File(taskPath),
      acceptanceCheckIds: [...(task.checks.fail_to_pass || []), ...(task.checks.custom || [])].filter((c) => c.required !== false).map((c) => c.id),
      hasPrivateSolution: Boolean(entry.solutionDir)
    });
  }

  const meta = { name: index.name || null, version: index.version || null, evaluatorVersion: index.evaluatorVersion, packFormat: index.packFormat, createdAt: index.createdAt || null, taskCount: tasks.length };
  return { root, meta, tasks, solutionDirs, summary };
}

/** Verify a pack without exposing content; returns { ok, errors, meta, summary }. */
export function verifyPack(packPath) {
  try {
    const { meta, summary } = loadPack(packPath, { verifyHashes: true });
    return { ok: true, errors: [], meta, summary };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], meta: null, summary: [] };
  }
}

/**
 * PUBLIC, committable summary of a pack: aggregate metadata + per-task hashes and
 * check ids ONLY. No prompts, fixtures, tests, or solutions. Safe for a public
 * manifest or PR text. Explicitly: these hashes guarantee integrity/version, NOT
 * confidentiality.
 */
export function packPublicSummary(packPath) {
  const { meta, summary } = loadPack(packPath, { verifyHashes: true });
  const families = new Set(summary.map((s) => s.family));
  return {
    kind: "holdout-pack-public-summary",
    name: meta.name,
    version: meta.version,
    evaluatorVersion: meta.evaluatorVersion,
    taskRows: summary.length,
    independentFamilies: families.size,
    note: "Hashes pin integrity + evaluator version; they do NOT by themselves guarantee confidentiality. Held-out content is never committed. Not a frozen set until independently reviewed + contamination-checked.",
    tasks: summary
  };
}
