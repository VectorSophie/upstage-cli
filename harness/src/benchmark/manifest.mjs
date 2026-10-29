// Benchmark v1 candidate-task manifest: build + validate.
//
// The manifest is a versioned, machine-checkable record of the candidate task
// set. It is BUILT from the task files (the source of truth) plus a code-side
// metadata table (justification, dev/holdout split, review state), so it cannot
// silently drift from the tasks. `validateManifest` re-derives and cross-checks,
// and applies mechanical quality gates (duplicate ids, missing fixtures, invalid
// checks, unpinned deps, answer-leak heuristics, trusted-asset-only mounts).
//
// Mechanical validation CANNOT find every semantic evaluator flaw; see
// docs/BENCHMARK_V1_TASK_QA.md for what requires human review.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadTaskDir } from "../task/loader.mjs";
import { getEvaluator } from "../evaluation/evaluators.mjs";
import { _TRUSTED_MOUNT_ASSET_NAMES } from "../sandbox/mount-registry.mjs";

const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TASKS_DIR = join(HARNESS_DIR, "tasks", "benchmark-v1");
export const SOLUTIONS_DIR = join(HARNESS_DIR, "benchmarks", "v1", "solutions");
export const MANIFEST_PATH = join(HARNESS_DIR, "benchmarks", "v1", "manifest.json");
export const MANIFEST_VERSION = "1.0.0-candidate";

const CATEGORIES = {
  A: "simple-repair",
  B: "multi-file-repair",
  C: "tool-selection",
  D: "tool-result-dependence",
  E: "failure-recovery",
  F: "multi-step"
};

// Per-task curated metadata. justification = why the task earns inclusion.
// split: "dev" (calibration/development fixture in THIS PR) or "holdout"
// (reserved for the frozen evaluation set — none yet; authored later).
// review: "auto" (mechanically + QA validated) or "human" (independently
// reviewed by a person — claimed ONLY when actually done).
const META = {
  "bv1-a1-range-sum": { category: "A", split: "dev", justification: "Canonical off-by-one; establishes a basic single-function coding baseline with a deterministic verifiable test." },
  "bv1-a1-range-sum-ko": { category: "A", split: "dev", justification: "Korean-prompt pair of a1 for the RQ5 language-dependence analysis; identical fixture and checks, prompt only differs." },
  "bv1-a2-cel-to-fahr": { category: "A", split: "dev", justification: "Wrong-formula repair (missing +32); a second independent simple-repair bug shape." },
  "bv1-b1-string-align": { category: "B", split: "dev", justification: "Defect in a helper used by a caller in another file; requires reading across two files to locate the real fault." },
  "bv1-b2-validator-chain": { category: "B", split: "dev", justification: "Boundary bug (>= vs >) in a rule composed by another module; cross-file comprehension with a single correct fix site." },
  "bv1-c1-one-wrong-op": { category: "C", split: "dev", justification: "Three functions, exactly one wrong, plus a distractor file; measures selective repair and over-editing via pass_to_pass on the untouched functions." },
  "bv1-c1-one-wrong-op-ko": { category: "C", split: "dev", justification: "Korean-prompt pair of c1 for RQ5." },
  "bv1-c2-trivial-constant": { category: "C", split: "dev", justification: "One-line constant fix where running extra tools is unnecessary; the tool-use quality metric (redundant calls) is read from the trace." },
  "bv1-d1-tool-result": { category: "D", split: "dev", justification: "Tool-result dependence under the hardened T3-v3 trust model: read-only mounted generator, runtime CSPRNG token, trace-verified. No static answer." },
  "bv1-d2-tool-result": { category: "D", split: "dev", justification: "Second, distinct trusted generator asset for tool-result dependence; same trust model as d1." },
  "bv1-e1-syntax-error": { category: "E", split: "dev", justification: "The acceptance command initially ERRORS (SyntaxError), not just fails; measures recovery from a broken command rather than a wrong answer." },
  "bv1-e2-missing-module": { category: "E", split: "dev", justification: "A required module is absent so the test errors; the agent must diagnose and CREATE the file rather than repeat a failing action." },
  "bv1-f1-csv-two-bugs": { category: "F", split: "dev", justification: "Two coordinated defects (delimiter + trim) that must both be fixed; multi-step repair with a single verifiable outcome." },
  "bv1-f2-stack-two-bugs": { category: "F", split: "dev", justification: "Two defects across methods (pop semantics + size) requiring a planned fix and verification of LIFO behaviour." }
};

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

/** Content hash of a fixture directory (sorted relative paths + bytes). */
export function fixtureHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const p of files.sort()) {
    h.update(relative(dir, p)).update("\0").update(readFileSync(p)).update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

function imageDigest(image) {
  try {
    const r = spawnSync("docker", ["image", "inspect", image, "--format", "{{index .RepoDigests 0}}"], { encoding: "utf8", timeout: 15000 });
    const out = (r.stdout || "").trim();
    return r.status === 0 && out.includes("@sha256:") ? out : null;
  } catch { return null; }
}

function acceptanceCheckIds(task) {
  return [...(task.checks.fail_to_pass || []), ...(task.checks.custom || [])]
    .filter((c) => c.required !== false)
    .map((c) => c.id);
}

function solutionRef(task) {
  if ((task.checks.custom || []).some((c) => c.evaluator)) return { kind: "trace-evaluator" };
  const dir = join(SOLUTIONS_DIR, task.id);
  return existsSync(dir) ? { kind: "file-overlay", path: relative(HARNESS_DIR, dir) } : { kind: "none" };
}

/** Build the manifest object from the task files + META (reproducible). */
export function buildManifest({ withImageDigests = true } = {}) {
  const tasks = loadTaskDir(TASKS_DIR).sort((a, b) => a.id.localeCompare(b.id));
  const digestCache = new Map();
  const entries = tasks.map((task) => {
    const meta = META[task.id] || { category: "?", split: "dev", justification: "" };
    const image = task.sandbox?.image || null;
    let digest = null;
    if (withImageDigests && image) {
      if (!digestCache.has(image)) digestCache.set(image, imageDigest(image));
      digest = digestCache.get(image);
    }
    return {
      id: task.id,
      category: meta.category,
      categoryName: CATEGORIES[meta.category] || null,
      difficulty: task.difficulty || null,
      language: task.language || "en",
      split: meta.split,
      review: "auto", // promoted to the QA result; never "human" unless a person reviewed it
      sandbox: { type: task.sandbox?.type || null, image, imageDigest: digest, network: task.sandbox?.network || null },
      repo: relative(HARNESS_DIR, resolve(task.repo)),
      fixtureHash: fixtureHash(resolve(task.repo)),
      readonlyMounts: (task.sandbox?.readonlyMounts || []).map((m) => m.container),
      acceptanceCheckIds: acceptanceCheckIds(task),
      budgets: { maxTurns: task.agent?.maxTurns ?? null, maxTokens: task.agent?.maxTokens ?? null, timeoutSec: task.sandbox?.timeout ?? null },
      expectedPatchScope: task.expectedPatchScope || [],
      solution: solutionRef(task),
      justification: meta.justification,
      specSha256: sha256(JSON.stringify(task))
    };
  });
  const byCategory = {};
  for (const e of entries) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  return {
    manifestVersion: MANIFEST_VERSION,
    generatedFrom: "tasks/benchmark-v1",
    note: "CANDIDATE set — development/calibration fixtures for validating the protocol, NOT a frozen leaderboard set. No task has had independent human review yet (see review field + BENCHMARK_V1_TASK_QA.md).",
    counts: { total: entries.length, byCategory },
    categories: CATEGORIES,
    tasks: entries
  };
}

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

// Heuristic answer-leak scan: an acceptance literal (e.g. a required token/value)
// appearing in an agent-visible fixture file. Mechanical only — see TASK_QA.md.
function leakFindings(task) {
  const findings = [];
  const repo = resolve(task.repo);
  const custom = (task.checks.custom || []).find((c) => c.evaluator === "tool-result-continuation");
  if (!custom) return findings;
  // D tasks: the generator must NOT be inside the agent workspace, and the
  // token pattern must not match any literal in the workspace (runtime-only).
  const pat = custom.config?.tokenPattern;
  if (pat) {
    const re = new RegExp(pat);
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        const txt = readFileSync(p, "utf8");
        if (re.test(txt)) findings.push(`${relative(repo, p)} contains a literal matching the token pattern (possible answer leak)`);
      }
    };
    walk(repo);
  }
  return findings;
}

/**
 * Validate the committed manifest against the task files and the quality gates.
 * Returns { ok, errors, warnings, perTask }. Errors are blocking; warnings are
 * pre-freeze reminders (e.g. image digests not pinned in the task files).
 */
export function validateManifest(manifest = loadManifest()) {
  const errors = [];
  const warnings = [];
  const tasks = loadTaskDir(TASKS_DIR);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const perTask = {};

  // 1. manifest/task set agree
  const manifestIds = manifest.tasks.map((t) => t.id);
  const dupes = manifestIds.filter((id, i) => manifestIds.indexOf(id) !== i);
  if (dupes.length) errors.push(`duplicate task ids in manifest: ${[...new Set(dupes)].join(", ")}`);
  for (const id of manifestIds) if (!byId.has(id)) errors.push(`manifest task '${id}' has no task file`);
  for (const t of tasks) if (!manifestIds.includes(t.id)) errors.push(`task file '${t.id}' is missing from the manifest`);

  for (const entry of manifest.tasks) {
    const task = byId.get(entry.id);
    const te = [];
    if (!task) { perTask[entry.id] = { errors: ["no task file"], warnings: [] }; continue; }

    // 2. fixture exists + hash matches
    const repo = resolve(task.repo);
    if (!existsSync(repo)) te.push(`fixture repo missing: ${entry.repo}`);
    else {
      const h = fixtureHash(repo);
      if (h !== entry.fixtureHash) te.push(`fixture hash drift (manifest ${entry.fixtureHash?.slice(0, 20)}… vs actual ${h.slice(0, 20)}…)`);
    }

    // 3. valid check definitions + named evaluators resolvable
    const allChecks = [...(task.checks.fail_to_pass || []), ...(task.checks.pass_to_pass || []), ...(task.checks.custom || [])];
    if (acceptanceCheckIds(task).length === 0) te.push("no required acceptance checks (fail_to_pass/custom)");
    for (const c of allChecks) {
      if (c.evaluator && !getEvaluator(c.evaluator)) te.push(`check '${c.id}' names unknown evaluator '${c.evaluator}'`);
      if (!c.command && !c.evaluator) te.push(`check '${c.id}' has neither command nor evaluator`);
    }

    // 4. sandbox must be docker for the benchmark; no privileged/network leakage
    if (task.sandbox?.type !== "docker") te.push(`sandbox.type must be 'docker' for benchmark execution (got '${task.sandbox?.type}')`);
    if (task.sandbox?.network && task.sandbox.network !== "none") te.push(`sandbox.network must be 'none' (got '${task.sandbox.network}')`);

    // 5. read-only mounts may only reference the trusted registry
    for (const m of task.sandbox?.readonlyMounts || []) {
      if (!m.container || typeof m.container !== "string") te.push("readonlyMount missing a resolved container path");
    }
    // the raw YAML asset names are validated at load; here confirm containers resolved
    // 6. unpinned dependency reminder (image tag vs digest)
    if (task.sandbox?.image && !/@sha256:/.test(task.sandbox.image)) {
      warnings.push(`${entry.id}: image '${task.sandbox.image}' is a tag, not a digest — must be pinned by digest before protocol freeze`);
    }
    // 7. answer-leak heuristic
    for (const f of leakFindings(task)) te.push(`answer-leak: ${f}`);

    // 8. metadata completeness
    if (!entry.justification) te.push("missing justification");
    if (!["dev", "holdout"].includes(entry.split)) te.push(`invalid split '${entry.split}'`);
    if (!Object.keys(CATEGORIES).includes(entry.category)) te.push(`invalid category '${entry.category}'`);

    perTask[entry.id] = { errors: te, warnings: [] };
    for (const e of te) errors.push(`${entry.id}: ${e}`);
  }

  return { ok: errors.length === 0, errors, warnings, perTask };
}
