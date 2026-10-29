// CPU-only regression tests for the benchmark v1 candidate set + tooling.
// No Docker, no model: structural invariants, manifest↔task consistency, the
// validator's quality gates (positive + injected negatives), and leak/isolation
// invariants. The real baseline/solution execution is `npm run benchmark:qa`
// (Docker), exercised separately.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { loadTaskDir } from "../src/task/loader.mjs";
import { restoreTrustedPaths } from "../src/task/runner.mjs";
import { buildManifest, validateManifest, loadManifest, fixtureHash, TASKS_DIR, SOLUTIONS_DIR } from "../src/benchmark/manifest.mjs";

const tasks = loadTaskDir(TASKS_DIR).sort((a, b) => a.id.localeCompare(b.id));
const manifest = buildManifest({ withImageDigests: false });

describe("benchmark v1 — candidate set shape", () => {
  it("spans all six categories A–F across both tranches", () => {
    assert.ok(manifest.counts.total >= 24 && manifest.counts.total <= 48, `count ${manifest.counts.total}`);
    for (const c of ["A", "B", "C", "D", "E", "F"]) assert.ok((manifest.counts.byCategory[c] || 0) >= 1, `category ${c} present`);
    assert.ok((manifest.counts.byTranche["v1-initial"] || 0) >= 1, "initial tranche present");
    assert.ok((manifest.counts.byTranche["v1-dataset"] || 0) >= 10, "dataset tranche present");
    for (const d of ["easy", "medium", "hard"]) assert.ok((manifest.counts.byDifficulty[d] || 0) >= 1, `difficulty ${d} present`);
  });

  it("every task runs in Docker with no network and has a required acceptance check", () => {
    for (const t of tasks) {
      assert.equal(t.sandbox?.type, "docker", `${t.id} must be docker`);
      assert.equal(t.sandbox?.network, "none", `${t.id} network none`);
      const acc = [...(t.checks.fail_to_pass || []), ...(t.checks.custom || [])].filter((c) => c.required !== false);
      assert.ok(acc.length >= 1, `${t.id} has a required acceptance check`);
      assert.ok((t.expectedPatchScope || []).length >= 1, `${t.id} declares expectedPatchScope`);
      assert.ok(["en", "ko"].includes(t.language), `${t.id} language`);
    }
  });

  it("includes paired Korean/English variants for the RQ5 language analysis", () => {
    const ko = tasks.filter((t) => t.language === "ko").map((t) => t.id);
    assert.ok(ko.length >= 1, "at least one Korean-prompt task");
    for (const id of ko) assert.ok(tasks.some((t) => t.id === id.replace(/-ko$/, "")), `${id} has an en counterpart`);
  });
});

describe("benchmark v1 — isolation / no answer leak", () => {
  it("category-D generators live OUTSIDE the copied workspace (repo has no generator)", () => {
    for (const t of tasks.filter((t) => (t.checks.custom || []).some((c) => c.evaluator))) {
      const repo = resolve(t.repo);
      const files = readdirSync(repo);
      assert.ok(!files.includes("gen.mjs"), `${t.id} workspace must not contain the generator`);
      // and no file in the workspace contains a literal matching the token pattern
      const re = new RegExp(t.checks.custom[0].config.tokenPattern);
      for (const f of files) {
        const p = join(repo, f);
        if (statSync(p).isFile()) assert.ok(!re.test(readFileSync(p, "utf8")), `${t.id}/${f} leaks a token literal`);
      }
    }
  });

  it("reference solutions live outside the fixture repos (never copied to the agent workspace)", () => {
    for (const t of tasks) {
      const sol = join(SOLUTIONS_DIR, t.id);
      if (!existsSync(sol)) continue;
      assert.ok(!resolve(sol).startsWith(resolve(t.repo) + "/"), `${t.id} solution must be outside the fixture repo`);
    }
  });

  it("no acceptance check command embeds the expected answer literal", () => {
    for (const t of tasks) {
      for (const c of t.checks.fail_to_pass || []) {
        // the hardened T3 lesson: never grep for a known token in a command
        assert.ok(!/BV1-|T3-|TOKEN-/.test(c.command || ""), `${t.id} check '${c.id}' embeds a token`);
      }
    }
  });
});

describe("benchmark v1 — manifest validator", () => {
  it("fixtureHash is deterministic", () => {
    const h1 = fixtureHash(resolve(tasks[0].repo));
    const h2 = fixtureHash(resolve(tasks[0].repo));
    assert.equal(h1, h2);
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
  });

  it("the freshly built manifest validates OK (no errors)", () => {
    const res = validateManifest(manifest);
    assert.equal(res.ok, true, res.errors.join(" | "));
  });

  it("the COMMITTED manifest.json is consistent with the task files", () => {
    assert.ok(existsSync(join(SOLUTIONS_DIR, "..", "manifest.json")) || true);
    const res = validateManifest(loadManifest());
    assert.equal(res.ok, true, res.errors.join(" | "));
  });

  it("detects a duplicate task id", () => {
    const m = structuredClone(manifest);
    m.tasks.push({ ...m.tasks[0] });
    const res = validateManifest(m);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /duplicate task ids/.test(e)));
  });

  it("detects a manifest entry with no task file", () => {
    const m = structuredClone(manifest);
    m.tasks.push({ ...m.tasks[0], id: "bv1-ghost" });
    const res = validateManifest(m);
    assert.ok(res.errors.some((e) => /bv1-ghost.*no task file/.test(e)));
  });

  it("detects a task file missing from the manifest", () => {
    const m = structuredClone(manifest);
    m.tasks = m.tasks.filter((t) => t.id !== tasks[0].id);
    const res = validateManifest(m);
    assert.ok(res.errors.some((e) => /missing from the manifest/.test(e)));
  });

  it("all task images are pinned by digest (no unpinned-image warnings)", () => {
    const res = validateManifest(manifest);
    assert.ok(!res.warnings.some((w) => /not a digest/.test(w)), res.warnings.join(" | "));
    for (const t of tasks) assert.match(t.sandbox.image, /@sha256:[0-9a-f]{64}$/, `${t.id} image pinned`);
  });
});

describe("benchmark v1 — evaluator integrity (trusted paths)", () => {
  const traceIds = new Set(tasks.filter((t) => (t.checks.custom || []).some((c) => c.evaluator)).map((t) => t.id));

  it("every scored test file referenced by a command check is a trustedPath", () => {
    for (const t of tasks) {
      if (traceIds.has(t.id)) continue; // category D uses an immutable mounted generator
      const trusted = new Set(t.trustedPaths || []);
      const cmds = [...(t.checks.fail_to_pass || []), ...(t.checks.pass_to_pass || [])].map((c) => c.command).filter(Boolean);
      for (const cmd of cmds) {
        for (const tok of cmd.split(/\s+/)) {
          if (/\.mjs$/.test(tok) && !tok.startsWith("-") && !tok.startsWith("/")) {
            assert.ok(trusted.has(tok), `${t.id}: scored test ${tok} must be a trustedPath`);
          }
        }
      }
    }
  });

  it("every trustedPath exists in the pristine fixture", () => {
    for (const t of tasks) {
      for (const rel of t.trustedPaths || []) assert.ok(existsSync(join(resolve(t.repo), rel)), `${t.id}:${rel} missing`);
    }
  });

  it("category-D (trace) tasks use a read-only mounted generator (no editable scored file)", () => {
    for (const id of traceIds) {
      const t = tasks.find((x) => x.id === id);
      const ev = (t.checks.custom || []).find((c) => c.evaluator);
      assert.ok(["tool-result-continuation", "tool-result-selection"].includes(ev.evaluator), `${id} trusted evaluator`);
      // the generator is always a read-only mount outside /workspace
      assert.ok((t.sandbox?.readonlyMounts || []).length >= 1, `${id} read-only mount`);
      // continuation evaluators additionally assert structural immutability
      if (ev.evaluator === "tool-result-continuation") assert.equal(ev.config?.immutableGenerator, true, `${id} immutableGenerator`);
      // selection evaluators must declare a selector (harness-owned, not agent code)
      if (ev.evaluator === "tool-result-selection") assert.ok(ev.config?.selector && typeof ev.config.selector === "object", `${id} selector`);
    }
  });

  it("restoreTrustedPaths overwrites agent edits from the fixture and flags tampering", () => {
    const fixture = mkdtempSync(join(tmpdir(), "h20-fx-"));
    const wd = mkdtempSync(join(tmpdir(), "h20-wd-"));
    try {
      writeFileSync(join(fixture, "app.test.mjs"), "REAL");
      writeFileSync(join(fixture, "sanity.test.mjs"), "SANE");
      writeFileSync(join(wd, "app.test.mjs"), "TAMPERED"); // agent weakened it
      writeFileSync(join(wd, "sanity.test.mjs"), "SANE");   // untouched
      const res = restoreTrustedPaths(fixture, wd, ["app.test.mjs", "sanity.test.mjs"], ["app.test.mjs"]);
      assert.equal(readFileSync(join(wd, "app.test.mjs"), "utf8"), "REAL");
      assert.deepEqual(res.tampered, ["app.test.mjs"]);
      assert.deepEqual(res.restored.sort(), ["app.test.mjs", "sanity.test.mjs"]);
      assert.equal(res.missing.length, 0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("restoreTrustedPaths restores a deleted file and neutralises a file→dir swap", () => {
    const fixture = mkdtempSync(join(tmpdir(), "h20-fx-"));
    const wd = mkdtempSync(join(tmpdir(), "h20-wd-"));
    try {
      writeFileSync(join(fixture, "app.test.mjs"), "REAL");
      mkdirSync(join(wd, "app.test.mjs")); // agent replaced the file with a directory
      const res = restoreTrustedPaths(fixture, wd, ["app.test.mjs"], ["app.test.mjs"]);
      assert.equal(readFileSync(join(wd, "app.test.mjs"), "utf8"), "REAL");
      assert.deepEqual(res.restored, ["app.test.mjs"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("restoreTrustedPaths refuses path escapes and reports missing sources", () => {
    const fixture = mkdtempSync(join(tmpdir(), "h20-fx-"));
    const wd = mkdtempSync(join(tmpdir(), "h20-wd-"));
    try {
      const res = restoreTrustedPaths(fixture, wd, ["../escape.mjs", "nope.mjs"], []);
      assert.deepEqual(res.restored, []);
      assert.ok(res.missing.includes("../escape.mjs") && res.missing.includes("nope.mjs"));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe("benchmark v1 — semantic-audit metadata + validator invariants", () => {
  it("every task carries audit metadata (construct, disclosure, action, family)", () => {
    for (const e of manifest.tasks) {
      assert.ok(e.measuredConstruct, `${e.id} measuredConstruct`);
      assert.ok(["low", "medium", "high"].includes(e.promptDisclosure), `${e.id} promptDisclosure`);
      assert.ok(["KEEP", "RECLASSIFY", "REWRITE", "DROP"].includes(e.auditAction), `${e.id} auditAction`);
      assert.ok(e.family, `${e.id} family`);
    }
  });

  it("no task claims independent human review; all are assistant-audited + auto-validated", () => {
    for (const e of manifest.tasks) {
      assert.equal(e.review.independentHumanReviewed, false, `${e.id} must not claim human review`);
      assert.equal(e.review.autoValidated, true);
      assert.equal(e.review.assistantSemanticReviewed, true);
    }
  });

  it("rows collapse to fewer independent families (ko/en + d1/d2 grouped)", () => {
    assert.ok(manifest.counts.independentFamilies < manifest.counts.total, "families < rows");
    assert.equal(manifest.counts.independentFamilies, Object.keys(manifest.families).length);
    assert.ok(manifest.families["d-token"].length === 2, "d1/d2 share one family");
    assert.ok(manifest.families["dx1-config-merge"].length === 2, "dx1 en/ko share one family");
    assert.ok(manifest.families["fr1-crash-recover"].length === 2, "fr1 en/ko share one family");
  });

  it("language pairs share the base fixture hash and acceptance checks", () => {
    const byId = new Map(manifest.tasks.map((e) => [e.id, e]));
    for (const e of manifest.tasks) {
      if (!e.baseTaskId) continue;
      const base = byId.get(e.baseTaskId);
      assert.ok(base, `${e.id} base present`);
      assert.equal(e.fixtureHash, base.fixtureHash, `${e.id} shares base fixture`);
      assert.deepEqual([...e.acceptanceCheckIds].sort(), [...base.acceptanceCheckIds].sort());
    }
  });

  it("validator rejects a manifest that claims independent human review", () => {
    const m = structuredClone(manifest);
    m.tasks[0].review.independentHumanReviewed = true;
    const res = validateManifest(m);
    assert.ok(res.errors.some((e) => /independentHumanReviewed must be false/.test(e)));
  });

  it("validator rejects a language pair whose fixture hash differs from its base", () => {
    const m = structuredClone(manifest);
    const ko = m.tasks.find((e) => e.id === "bv1-a1-range-sum-ko");
    ko.fixtureHash = "sha256:" + "0".repeat(64);
    const res = validateManifest(m);
    assert.ok(res.errors.some((e) => /must share the base fixture/.test(e)));
  });
});
