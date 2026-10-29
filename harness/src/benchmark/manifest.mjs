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

// Per-task curated metadata, including the Phase-2 semantic-audit fields.
//
//  category          original taxonomy letter (A–F); kept for continuity.
//  split             "dev" (calibration fixture in THIS PR) or "holdout"
//                    (reserved for the frozen set — none yet; authored later).
//  family            underlying-problem id. Rows that share a family are NOT
//                    independent evidence (ko/en pairs; d1/d2 near-duplicates).
//  baseTaskId/pairId/langVariant  language-pairing for RQ5 (paired, not
//                    independent, observations).
//  measuredConstruct what the task ACTUALLY measures once prompt disclosure is
//                    accounted for (vs the category's nominal intent).
//  promptDisclosure  how much the prompt reveals: "low" | "medium" | "high".
//  auditAction       KEEP | RECLASSIFY | REWRITE | DROP (Phase 2 outcome).
//  integrity         how the grade is protected from agent tampering:
//                    "trusted-path-restore" (file tasks) or
//                    "trace-evaluator-immutable-mount" (category D).
//  reclassification  corrected construct label when auditAction=RECLASSIFY.
//
// review state is structured (not a single "auto"): mechanical/QA validation
// and this assistant semantic audit are TRUE; independent HUMAN review is FALSE
// for every task and is a freeze prerequisite — never claimed here.
const META = {
  "bv1-a1-range-sum": { category: "A", split: "dev", family: "a1-range-sum", pairId: "pair-a1", langVariant: "en", measuredConstruct: "instruction-following localized arithmetic repair", promptDisclosure: "high", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Canonical off-by-one; a basic single-function repair baseline with a deterministic verifiable test. Prompt names the file, function, and defect type, so it measures instruction-following + minimal edit, NOT autonomous diagnosis." },
  "bv1-a1-range-sum-ko": { category: "A", split: "dev", family: "a1-range-sum", baseTaskId: "bv1-a1-range-sum", pairId: "pair-a1", langVariant: "ko", measuredConstruct: "instruction-following localized arithmetic repair (Korean prompt)", promptDisclosure: "high", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Korean-prompt pair of a1 for RQ5; identical fixture and checks, prompt only differs. Paired observation, not an independent task." },
  "bv1-a2-cel-to-fahr": { category: "A", split: "dev", family: "a2-cel-to-fahr", langVariant: "en", measuredConstruct: "formula repair with light diagnosis (defect not stated)", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Wrong-formula repair; prompt says the value is wrong but NOT that +32 is missing, so some diagnosis is required. Grader strengthened with negative/non-round cases to defeat two-point hardcoding." },
  "bv1-b1-string-align": { category: "B", split: "dev", family: "b1-string-align", langVariant: "en", measuredConstruct: "guided cross-file repair (fault location disclosed)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "guided multi-file repair — the prompt names the helper as the real defect, so cross-file DIAGNOSIS is largely given; the agent must still read two files and edit the correct site.", integrity: "trusted-path-restore", justification: "Defect in a helper used by a caller in another file. The prompt discloses that the real defect is in the helper, reducing the diagnostic demand; retained as guided cross-file repair." },
  "bv1-b2-validator-chain": { category: "B", split: "dev", family: "b2-validator-chain", langVariant: "en", measuredConstruct: "guided cross-file boundary repair (fault + boundary disclosed)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "guided multi-file repair — prompt states the zero-boundary bug and that it lives in the dependency rule.", integrity: "trusted-path-restore", justification: "Boundary bug (>= vs >) in a rule composed by another module. Prompt discloses the bug and its location; retained as guided cross-file repair, not blind diagnosis." },
  "bv1-c1-one-wrong-op": { category: "C", split: "dev", family: "c1-one-wrong-op", pairId: "pair-c1", langVariant: "en", measuredConstruct: "selective repair among candidates + over-edit restraint", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Three functions, exactly one wrong (not said which), plus a distractor file; measures locating the wrong one and NOT editing the others (pass_to_pass guards add/sub). Genuine selective repair." },
  "bv1-c1-one-wrong-op-ko": { category: "C", split: "dev", family: "c1-one-wrong-op", baseTaskId: "bv1-c1-one-wrong-op", pairId: "pair-c1", langVariant: "ko", measuredConstruct: "selective repair among candidates (Korean prompt)", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Korean-prompt pair of c1 for RQ5. Paired observation, not independent." },
  "bv1-c2-trivial-constant": { category: "C", split: "dev", family: "c2-trivial-constant", langVariant: "en", measuredConstruct: "tool restraint / instruction-following (exact value given)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "tool-use restraint — the required value is given; the behaviour under test is NOT running unnecessary tools (read from the trace), not repair difficulty.", integrity: "trusted-path-restore", justification: "One-line constant fix where the answer is disclosed; the signal is the redundant-tool-call count from the trace, so it measures restraint, not debugging." },
  "bv1-d1-tool-result": { category: "D", split: "dev", family: "d-token", langVariant: "en", measuredConstruct: "tool-result dependence (execute trusted tool, consume its stdout)", promptDisclosure: "high", auditAction: "KEEP", integrity: "trace-evaluator-immutable-mount", justification: "Tool-result dependence under the hardened T3-v3 model: read-only mounted generator, runtime CSPRNG token, trace-verified. High disclosure is intrinsic to the category (the exact command is the point)." },
  "bv1-d2-tool-result": { category: "D", split: "dev", family: "d-token", langVariant: "en", measuredConstruct: "tool-result dependence (same template as d1)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "NOT independent of d1 — identical workflow/template with a different generator asset; grouped into family 'd-token'. Counts as one underlying problem, not two.", integrity: "trace-evaluator-immutable-mount", justification: "Second generator asset for tool-result dependence; mechanically distinct token but the same cognitive demand as d1. Retained as a within-family replicate, not independent evidence." },
  "bv1-e1-syntax-error": { category: "E", split: "dev", family: "e1-syntax-error", langVariant: "en", measuredConstruct: "guided syntax repair (instruction-following)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "instruction-following repair, NOT autonomous failure recovery — the prompt names broken.mjs, states it is a syntax error, and gives the required behaviour; the agent does not discover or diagnose the failure.", integrity: "trusted-path-restore", justification: "Acceptance initially errors (SyntaxError), but the prompt discloses the file, the defect class, and the target behaviour, so it measures guided repair. Genuine recovery would withhold the diagnosis." },
  "bv1-e2-missing-module": { category: "E", split: "dev", family: "e2-missing-module", langVariant: "en", measuredConstruct: "spec-driven module creation (instruction-following)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "instruction-following module creation, NOT failure recovery — the prompt states the module is missing and gives its full slugify spec.", integrity: "trusted-path-restore", justification: "A required module is absent so the test errors, but the prompt discloses the missing file and the exact behaviour to implement; the agent follows a spec rather than diagnosing an unexpected failure." },
  "bv1-f1-csv-two-bugs": { category: "F", split: "dev", family: "f1-csv-two-bugs", langVariant: "en", measuredConstruct: "compound localized repair (two disclosed defects, weak step dependency)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "compound repair, NOT genuine multi-step planning — both defects are disclosed and fixed within one short function with little inter-step dependency.", integrity: "trusted-path-restore", justification: "Two defects (delimiter + trim) in one function; both are named in the prompt. Limited planning demand; retained as a compound-repair calibration item." },
  "bv1-f2-stack-two-bugs": { category: "F", split: "dev", family: "f2-stack-two-bugs", langVariant: "en", measuredConstruct: "compound repair across two methods (two disclosed defects)", promptDisclosure: "high", auditAction: "RECLASSIFY", reclassification: "compound repair + verification, NOT dependent multi-step planning — the two method fixes are largely independent and both are disclosed.", integrity: "trusted-path-restore", justification: "Two defects across methods (pop semantics + size). Both disclosed; fixes are nearly independent, so planning demand is modest. Retained as compound-repair + verification." },

  // ── v1-dataset tranche (substantive, low-disclosure) ──────────────────────
  "bv1-dx1-config-merge": { category: "B", split: "dev", tranche: "v1-dataset", family: "dx1-config-merge", pairId: "pair-dx1", langVariant: "en", measuredConstruct: "cross-file diagnosis — nested deep-merge defect located by tracing loadConfig→deepMerge (location NOT disclosed)", promptDisclosure: "low", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Observable symptom only (nested override drops siblings); the agent must trace across config/defaults/merge to find the shallow-merge bug. A one-level 'fix server only' hack fails the top-level-override case." },
  "bv1-dx1-config-merge-ko": { category: "B", split: "dev", tranche: "v1-dataset", family: "dx1-config-merge", baseTaskId: "bv1-dx1-config-merge", pairId: "pair-dx1", langVariant: "ko", measuredConstruct: "cross-file diagnosis (Korean prompt)", promptDisclosure: "low", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Korean pair of dx1; identical fixture/grader/budgets/tools, prompt language only differs. Paired observation, not independent." },
  "bv1-dx2-route-normalize": { category: "B", split: "dev", tranche: "v1-dataset", family: "dx2-route-normalize", langVariant: "en", measuredConstruct: "cross-file diagnosis — route-key normalization defect traced across router→routes→path (location NOT disclosed)", promptDisclosure: "low", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Symptom only (trailing slash misses a route); the real defect is in a normalization helper two files away. Fixing the wrong layer does not pass." },
  "bv1-dx3-stats-mean": { category: "B", split: "dev", tranche: "v1-dataset", family: "dx3-stats-mean", langVariant: "en", measuredConstruct: "cross-file diagnosis — off-by-one divisor in a mean helper traced summary→mean (location NOT disclosed)", promptDisclosure: "low", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Symptom only (wrong average); the sum is correct, so the agent must localize the defect to mean(). Single-value hardcode fails the multiple cases incl. a single-element list." },
  "bv1-ts1-target-select": { category: "C", split: "dev", tranche: "v1-dataset", family: "ts1-target-select", langVariant: "en", measuredConstruct: "target selection among distractors — identify which of several settings modules is actually imported", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Two settings modules exist; only one is imported by the code under test. Editing the distractor (legacy_settings) does not pass. Measures selecting the right target, not repair difficulty." },
  "bv1-fr1-crash-recover": { category: "E", split: "dev", tranche: "v1-dataset", family: "fr1-crash-recover", pairId: "pair-fr1", langVariant: "en", measuredConstruct: "failure recovery — observe a thrown TypeError, diagnose the missing-field cause, recover (location NOT disclosed)", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "names(RECORDS) throws on a record lacking user; the agent must run it, read the stack, and add safe handling. An all-'anonymous' shortcut fails because real names must be preserved." },
  "bv1-fr1-crash-recover-ko": { category: "E", split: "dev", tranche: "v1-dataset", family: "fr1-crash-recover", baseTaskId: "bv1-fr1-crash-recover", pairId: "pair-fr1", langVariant: "ko", measuredConstruct: "failure recovery (Korean prompt)", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Korean pair of fr1; identical fixture/grader/budgets/tools. Paired observation, not independent." },
  "bv1-fr2-root-cause": { category: "E", split: "dev", tranche: "v1-dataset", family: "fr2-root-cause", langVariant: "en", measuredConstruct: "failure recovery + root-cause — resist symptom suppression (fix the invalid default, do NOT weaken the validator)", promptDisclosure: "low", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "run() throws a RangeError from a valid validator fed a bad default. The naive fix (weaken the validator) fails because invalid sizes must still be rejected; the agent must find the real cause (the default)." },
  "bv1-ms2-coordinated": { category: "F", split: "dev", tranche: "v1-dataset", family: "ms2-coordinated", langVariant: "en", measuredConstruct: "dependent multi-step — two COORDINATED edits (topTwo depends on prepare's output order)", promptDisclosure: "low", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "Both prepare() and topTwo() are wrong in interlocking ways; fixing only one fails (verified). Genuine dependency between the two changes, not two independent edits." },
  "bv1-cr1-stop-when-done": { category: "A", split: "dev", tranche: "v1-dataset", family: "cr1-stop-when-done", langVariant: "en", measuredConstruct: "completion reliability — minimal verifiable fix; whether the agent STOPS after success (post-solution overhead from the trace)", promptDisclosure: "high", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "A small, unambiguous off-by-one fix; the construct is the completion/stop decision (secondary metric Post-Solution Overhead), not debugging difficulty." },
  "bv1-sr1-clamp": { category: "A", split: "dev", tranche: "v1-dataset", family: "sr1-clamp", langVariant: "en", measuredConstruct: "simple localized repair (baseline), symptom-only disclosure", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trusted-path-restore", justification: "A kept single-function baseline (missing upper bound). Symptom given, defect not; retained so the set has a localized-repair anchor without dominating it." },
  "bv1-tr1-json-field": { category: "D", split: "dev", tranche: "v1-dataset", family: "tr1-json", langVariant: "en", measuredConstruct: "tool-result interpretation — select the correct JSON field (api service's port) from runtime output", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trace-evaluator-immutable-mount", justification: "Beyond copying stdout: the trusted evaluator recomputes the api port from the qualifying run's own JSON, so copying the whole output or any other port fails. Dynamic CSPRNG tokens; read-only mounted generator." },
  "bv1-tr2-json-max": { category: "D", split: "dev", tranche: "v1-dataset", family: "tr2-json", langVariant: "en", measuredConstruct: "tool-result interpretation — select the id of the maximum-score item", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trace-evaluator-immutable-mount", justification: "Requires computing an argmax over structured output, not copying. Distinct random scores guarantee a unique answer; evaluator recomputes it from the run's stdout." },
  "bv1-ms1-indirect": { category: "D", split: "dev", tranche: "v1-dataset", family: "ms1-indirect", langVariant: "en", measuredConstruct: "dependent tool-result interpretation — indirect selection ports[primary] (which value is correct depends on another field)", promptDisclosure: "medium", auditAction: "KEEP", integrity: "trace-evaluator-immutable-mount", justification: "Two-step dependency within one runtime output: read primary, then select ports[primary]. The evaluator applies the same indirect selector to the run's JSON, so a wrong port fails." }
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

// Test files referenced by command checks (fail_to_pass + pass_to_pass). These
// run inside the agent workspace, so each must be a trustedPath.
function referencedTestFiles(task) {
  const files = new Set();
  const cmds = [...(task.checks.fail_to_pass || []), ...(task.checks.pass_to_pass || [])]
    .map((c) => c.command).filter((c) => typeof c === "string");
  for (const cmd of cmds) {
    for (const tok of cmd.split(/\s+/)) {
      // a bare, workspace-relative *.mjs operand (not a flag, not an absolute
      // mounted path like /opt/bench/d1.mjs)
      if (/\.mjs$/.test(tok) && !tok.startsWith("-") && !tok.startsWith("/")) files.add(tok);
    }
  }
  return files;
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
    const isTrace = (task.checks.custom || []).some((c) => c.evaluator);
    return {
      id: task.id,
      category: meta.category,
      categoryName: CATEGORIES[meta.category] || null,
      difficulty: task.difficulty || null,
      language: task.language || "en",
      split: meta.split,
      tranche: meta.tranche || "v1-initial",
      // Structured review state — the Phase-8 distinction. autoValidated +
      // assistantSemanticReviewed are TRUE; independentHumanReviewed is FALSE for
      // every candidate (a freeze prerequisite) and is never claimed here.
      review: { autoValidated: true, assistantSemanticReviewed: true, independentHumanReviewed: false },
      // Phase-2 semantic-audit fields.
      family: meta.family || task.id,
      baseTaskId: meta.baseTaskId || null,
      pairId: meta.pairId || null,
      langVariant: meta.langVariant || (task.language || "en"),
      measuredConstruct: meta.measuredConstruct || null,
      promptDisclosure: meta.promptDisclosure || null,
      auditAction: meta.auditAction || null,
      reclassification: meta.reclassification || null,
      integrity: meta.integrity || (isTrace ? "trace-evaluator-immutable-mount" : "trusted-path-restore"),
      sandbox: { type: task.sandbox?.type || null, image, imageDigest: digest, network: task.sandbox?.network || null },
      repo: relative(HARNESS_DIR, resolve(task.repo)),
      fixtureHash: fixtureHash(resolve(task.repo)),
      readonlyMounts: (task.sandbox?.readonlyMounts || []).map((m) => m.container),
      acceptanceCheckIds: acceptanceCheckIds(task),
      trustedPaths: task.trustedPaths || [],
      budgets: { maxTurns: task.agent?.maxTurns ?? null, maxTokens: task.agent?.maxTokens ?? null, timeoutSec: task.sandbox?.timeout ?? null },
      expectedPatchScope: task.expectedPatchScope || [],
      solution: solutionRef(task),
      justification: meta.justification,
      specSha256: sha256(JSON.stringify(task))
    };
  });
  const byCategory = {};
  for (const e of entries) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  const byTranche = {};
  for (const e of entries) byTranche[e.tranche] = (byTranche[e.tranche] || 0) + 1;
  const byDifficulty = {};
  for (const e of entries) byDifficulty[e.difficulty || "?"] = (byDifficulty[e.difficulty || "?"] || 0) + 1;
  // Family / language-pair rollup: how many INDEPENDENT underlying problems the
  // rows represent (ko/en pairs and d1/d2 collapse to one family each).
  const families = {};
  for (const e of entries) (families[e.family] ||= []).push(e.id);
  const languagePairs = {};
  for (const e of entries) if (e.pairId) (languagePairs[e.pairId] ||= []).push(e.id);
  // A language pair is a REPLICATE pair only when it has ≥2 members here.
  const realPairs = Object.fromEntries(Object.entries(languagePairs).filter(([, v]) => v.length >= 2));
  return {
    manifestVersion: MANIFEST_VERSION,
    generatedFrom: "tasks/benchmark-v1",
    note: "CANDIDATE set — development/calibration fixtures for validating the protocol, NOT a frozen leaderboard set. Every task has passed mechanical + Docker QA and an ASSISTANT semantic audit (Phase 2); NONE has had independent human review (review.independentHumanReviewed=false) — a freeze prerequisite. See BENCHMARK_V1_SEMANTIC_AUDIT.md + BENCHMARK_V1_TASK_QA.md.",
    counts: {
      total: entries.length,
      byCategory,
      byTranche,
      byDifficulty,
      independentFamilies: Object.keys(families).length,
      languagePairs: Object.keys(realPairs).length
    },
    categories: CATEGORIES,
    families,
    languagePairs: realPairs,
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

    // 5b. EVALUATOR INTEGRITY. A scored test file that lives in the agent
    // workspace must be a trustedPath (restored from the pristine fixture before
    // scoring; see runner.restoreTrustedPaths) — otherwise the agent could edit,
    // rename, weaken, or delete it to grade itself. Trace tasks (category D)
    // instead require an immutable, read-only mounted generator.
    const isTrace = (task.checks.custom || []).some((c) => c.evaluator);
    if (isTrace) {
      for (const c of (task.checks.custom || []).filter((x) => x.evaluator === "tool-result-continuation")) {
        if (c.config?.immutableGenerator !== true) te.push(`trace check '${c.id}' must set config.immutableGenerator:true (read-only mounted generator)`);
      }
      if ((task.sandbox?.readonlyMounts || []).length === 0) te.push("trace (category-D) task must declare a read-only mounted generator");
    } else {
      const trusted = new Set(task.trustedPaths || []);
      for (const ref of referencedTestFiles(task)) {
        if (!trusted.has(ref)) te.push(`scored test file '${ref}' is agent-editable — it must be listed in trustedPaths (evaluator-integrity invariant)`);
      }
    }
    // 5c. every declared trustedPath must exist in the pristine fixture (else the
    // post-agent restore would misconfigure and error at run time).
    for (const rel of task.trustedPaths || []) {
      if (existsSync(repo) && !existsSync(join(repo, rel))) te.push(`trustedPath '${rel}' does not exist in the fixture`);
    }

    // 5d. NEVER claim independent human review for a candidate task.
    if (entry.review && entry.review.independentHumanReviewed === true) {
      te.push("review.independentHumanReviewed must be false for candidate tasks (no independent human review has occurred)");
    }
    // 5e. audit metadata completeness.
    if (!entry.measuredConstruct) te.push("missing measuredConstruct (semantic-audit field)");
    if (!["low", "medium", "high"].includes(entry.promptDisclosure)) te.push(`invalid/missing promptDisclosure '${entry.promptDisclosure}'`);
    if (!["KEEP", "RECLASSIFY", "REWRITE", "DROP"].includes(entry.auditAction)) te.push(`invalid/missing auditAction '${entry.auditAction}'`);

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

  // 9. language pairs are PAIRED observations: a ko variant must point at an
  // existing base task, use the identical fixture (same hash) and the same
  // acceptance checks — otherwise it cannot isolate a language effect.
  const entryById = new Map(manifest.tasks.map((e) => [e.id, e]));
  for (const entry of manifest.tasks) {
    if (!entry.baseTaskId) continue;
    const base = entryById.get(entry.baseTaskId);
    if (!base) { errors.push(`${entry.id}: baseTaskId '${entry.baseTaskId}' is not in the manifest`); continue; }
    if (entry.fixtureHash !== base.fixtureHash) errors.push(`${entry.id}: language pair must share the base fixture (hash differs from ${entry.baseTaskId})`);
    const a = JSON.stringify([...(entry.acceptanceCheckIds || [])].sort());
    const b = JSON.stringify([...(base.acceptanceCheckIds || [])].sort());
    if (a !== b) errors.push(`${entry.id}: language pair must use the same acceptance checks as ${entry.baseTaskId}`);
    if (entry.family !== base.family) errors.push(`${entry.id}: language pair must share the base family`);
  }

  return { ok: errors.length === 0, errors, warnings, perTask };
}
