import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validate, resolveImport, TASK_SCHEMA } from "../src/task/schema.mjs";
import { loadTask } from "../src/task/loader.mjs";

// ── validate() ────────────────────────────────────────────────────────────────

describe("validate — required fields", () => {
  it("accepts a minimal valid spec", () => {
    const spec = {
      id: "test-task",
      repo: "./fixtures/missing-import",
      prompt: "Fix the bug.",
      checks: { fail_to_pass: [] }
    };
    const { valid, errors } = validate(spec);
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  it("rejects spec missing id", () => {
    const { valid, errors } = validate({ repo: "./x", prompt: "p", checks: {} });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("id")));
  });

  it("rejects spec missing repo", () => {
    const { valid, errors } = validate({ id: "x", prompt: "p", checks: {} });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("repo")));
  });

  it("rejects spec missing prompt", () => {
    const { valid, errors } = validate({ id: "x", repo: "./x", checks: {} });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("prompt")));
  });

  it("rejects spec missing checks", () => {
    const { valid, errors } = validate({ id: "x", repo: "./x", prompt: "p" });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("checks")));
  });

  it("rejects empty id string", () => {
    const { valid, errors } = validate({ id: "  ", repo: "./x", prompt: "p", checks: {} });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("id must not be empty")));
  });

  it("rejects empty prompt string", () => {
    const { valid, errors } = validate({ id: "x", repo: "./x", prompt: "", checks: {} });
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("prompt must not be empty")));
  });
});

describe("validate — optional field validation", () => {
  it("rejects invalid sandbox.type", () => {
    const spec = { id: "x", repo: "./x", prompt: "p", checks: {}, sandbox: { type: "firecracker" } };
    const { valid, errors } = validate(spec);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("sandbox.type")));
  });

  it("rejects invalid context.strategy", () => {
    const spec = { id: "x", repo: "./x", prompt: "p", checks: {}, context: { strategy: "quantum" } };
    const { valid, errors } = validate(spec);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("context.strategy")));
  });

  it("accepts native sandbox type", () => {
    const spec = { id: "x", repo: "./x", prompt: "p", checks: {}, sandbox: { type: "native" } };
    assert.equal(validate(spec).valid, true);
  });

  it("accepts all valid context strategies", () => {
    const strategies = ["default", "full-repo", "retrieval", "symbol-graph", "failing-test", "recent-diffs"];
    for (const strategy of strategies) {
      const spec = { id: "x", repo: "./x", prompt: "p", checks: {}, context: { strategy } };
      assert.equal(validate(spec).valid, true, `strategy ${strategy} should be valid`);
    }
  });
});

// ── resolveImport() ───────────────────────────────────────────────────────────

describe("resolveImport — _import composition", () => {
  let tmpDir;
  before(() => { tmpDir = mkdtempSync(join(tmpdir(), "h1-schema-")); });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("merges parent defaults with child overrides", () => {
    const parentPath = join(tmpDir, "base.yaml");
    writeFileSync(parentPath, `sandbox:\n  timeout: 300\n  type: native\n`);

    const childSpec = {
      id: "child-task",
      repo: "./x",
      prompt: "Do it.",
      checks: {},
      _import: "./base.yaml",
      sandbox: { timeout: 60 }
    };
    const resolved = resolveImport(childSpec, join(tmpDir, "child.yaml"));
    assert.equal(resolved.sandbox.timeout, 60, "child overrides parent timeout");
    assert.equal(resolved.sandbox.type, "native", "parent value preserved when child omits");
  });

  it("detects circular _import and throws", () => {
    const aPath = join(tmpDir, "circular-a.yaml");
    const bPath = join(tmpDir, "circular-b.yaml");
    writeFileSync(aPath, `_import: ./circular-b.yaml\n`);
    writeFileSync(bPath, `_import: ./circular-a.yaml\nid: x\nrepo: ./x\nprompt: p\nchecks: {}\n`);
    const raw = { _import: "./circular-a.yaml", id: "x", repo: "./x", prompt: "p", checks: {} };
    assert.throws(() => resolveImport(raw, join(tmpDir, "root.yaml")), /circular/i);
  });

  it("applies DEFAULTS when no _import", () => {
    const spec = { id: "x", repo: "./x", prompt: "p", checks: {} };
    const resolved = resolveImport(spec, "/some/path.yaml");
    assert.equal(resolved.sandbox.timeout, 120);
    assert.equal(resolved.context.strategy, "default");
    assert.equal(resolved.version, 1);
  });
});

// ── loadTask() ────────────────────────────────────────────────────────────────

describe("loadTask — integration", () => {
  it("loads fix-missing-import.yaml without errors", () => {
    const task = loadTask(new URL("../tasks/fix-missing-import.yaml", import.meta.url).pathname.slice(1));
    assert.equal(task.id, "fix-missing-import");
    assert.equal(task.difficulty, "easy");
    assert.ok(Array.isArray(task.checks.fail_to_pass));
    assert.ok(task.checks.fail_to_pass.length > 0);
  });

  it("loadTask throws on invalid spec", () => {
    let tmpDir2;
    tmpDir2 = mkdtempSync(join(tmpdir(), "h1-load-"));
    const badPath = join(tmpDir2, "bad.yaml");
    writeFileSync(badPath, "id: ''\nrepo: ./x\nprompt: fix\nchecks: {}\n");
    assert.throws(() => loadTask(badPath), /Invalid task/);
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});
