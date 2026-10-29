// CPU-only regression tests for the benchmark v1 candidate set + tooling.
// No Docker, no model: structural invariants, manifest↔task consistency, the
// validator's quality gates (positive + injected negatives), and leak/isolation
// invariants. The real baseline/solution execution is `npm run benchmark:qa`
// (Docker), exercised separately.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

import { loadTaskDir } from "../src/task/loader.mjs";
import { buildManifest, validateManifest, loadManifest, fixtureHash, TASKS_DIR, SOLUTIONS_DIR } from "../src/benchmark/manifest.mjs";

const tasks = loadTaskDir(TASKS_DIR).sort((a, b) => a.id.localeCompare(b.id));
const manifest = buildManifest({ withImageDigests: false });

describe("benchmark v1 — candidate set shape", () => {
  it("has 12–18 tasks spanning all six categories A–F", () => {
    assert.ok(manifest.counts.total >= 12 && manifest.counts.total <= 18, `count ${manifest.counts.total}`);
    for (const c of ["A", "B", "C", "D", "E", "F"]) assert.ok((manifest.counts.byCategory[c] || 0) >= 1, `category ${c} present`);
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

  it("flags unpinned image tags as pre-freeze warnings (not blocking)", () => {
    const res = validateManifest(manifest);
    assert.ok(res.warnings.some((w) => /not a digest/.test(w)));
  });
});
