// REAL Docker adversarial regression for the benchmark-v1 evaluator-integrity
// fix. Drives the actual TaskRunner on the real bv1-a1 task with hand-written
// adapters that either solve the task or TAMPER with the scored test files
// (rename tests out of the ^fix_ pattern, weaken assertions, delete the file)
// WITHOUT fixing the bug. The runner restores task.trustedPaths from the
// pristine fixture before scoring, so tampering cannot change the grade.
//
// It also proves the vulnerability is real: with trustedPaths stripped, the
// rename-tamper agent PASSES vacuously (node --test treats a zero-match
// name-pattern as success); with trustedPaths present it FAILS. When Docker is
// unavailable every test is SKIPPED (not passed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DockerSandbox } from "../src/sandbox/docker.mjs";
import { loadTask } from "../src/task/loader.mjs";
import { TaskRunner } from "../src/task/runner.mjs";

const DOCKER = process.env.SKIP_DOCKER !== "1" && DockerSandbox.isAvailable();
const skip = DOCKER ? false : "Docker not available — NOT EXECUTED";
const A1 = new URL("../tasks/benchmark-v1/bv1-a1-range-sum.yaml", import.meta.url).pathname;

// Minimal host-side adapters (like MockAgent): they only write files into the
// workspace; nothing is executed by the "agent" itself.
function adapter(id, fn) {
  return {
    id,
    supportsSandbox: true,
    async run(_task, ctx) {
      fn(ctx.workdir);
      return { ok: true, turns: 1, toolCalls: 1, usage: null, events: [], stopReason: "end_turn" };
    }
  };
}

const CORRECT_SRC = "export function rangeSum(n) {\n  let s = 0;\n  for (let i = 1; i <= n; i++) s += i;\n  return s;\n}\n";
// Renames every test away from ^fix_ so the acceptance pattern matches nothing
// (vacuous exit 0), and does NOT fix the bug.
const RENAME_TESTS = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { rangeSum } from "./src.mjs";\ntest("zzz_disabled", () => assert.ok(true));\n';
// Keeps the fix_ names but replaces the real assertions with trivial passes.
const WEAKEN_TESTS = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fix_sum_1_to_5", () => assert.ok(true));\ntest("fix_sum_1_to_10", () => assert.ok(true));\n';

const honest = adapter("honest", (wd) => writeFileSync(join(wd, "src.mjs"), CORRECT_SRC));
const tamperRename = adapter("tamper-rename", (wd) => writeFileSync(join(wd, "app.test.mjs"), RENAME_TESTS));
const tamperWeaken = adapter("tamper-weaken", (wd) => writeFileSync(join(wd, "app.test.mjs"), WEAKEN_TESTS));
const tamperDelete = adapter("tamper-delete", (wd) => rmSync(join(wd, "app.test.mjs"), { force: true }));

async function runWith(adapterObj, { stripTrusted = false } = {}) {
  const task = loadTask(A1);
  if (stripTrusted) delete task.trustedPaths; // simulate the pre-fix harness
  const runner = new TaskRunner();
  return runner.run(task, adapterObj);
}

describe("benchmark-v1 evaluator integrity — trusted-path restore", { skip }, () => {
  it("the bv1-a1 task declares its scored test files as trustedPaths", () => {
    const task = loadTask(A1);
    assert.ok((task.trustedPaths || []).includes("app.test.mjs"), "app.test.mjs must be trusted");
    assert.ok((task.trustedPaths || []).includes("sanity.test.mjs"), "sanity.test.mjs must be trusted");
  });

  it("a correct solution passes", async () => {
    const r = await runWith(honest);
    assert.equal(r.status, "pass", JSON.stringify(r.outcome));
  });

  it("VULNERABILITY (control): renaming tests away from ^fix_ PASSES when trustedPaths is stripped", async () => {
    const r = await runWith(tamperRename, { stripTrusted: true });
    // node --test treats a zero-match name-pattern as exit 0 → the bug is unfixed
    // yet acceptance "passes". This is exactly what the fix must prevent.
    assert.equal(r.status, "pass", `expected the pre-fix bypass to pass; got ${JSON.stringify(r.outcome)}`);
  });

  it("FIX: the same rename tamper FAILS with trustedPaths (test restored, bug unfixed)", async () => {
    const r = await runWith(tamperRename);
    assert.equal(r.status, "fail", JSON.stringify(r.outcome));
    assert.deepEqual(r.safety.tamperedTrustedPaths, ["app.test.mjs"]);
    assert.ok(r.safety.riskFlags.includes("trusted_path_modified"));
  });

  it("FIX: weakening assertions (keeping fix_ names) FAILS — restored to real assertions", async () => {
    const r = await runWith(tamperWeaken);
    assert.equal(r.status, "fail", JSON.stringify(r.outcome));
    assert.deepEqual(r.safety.tamperedTrustedPaths, ["app.test.mjs"]);
  });

  it("FIX: deleting the scored test FAILS — the file is restored before scoring", async () => {
    const r = await runWith(tamperDelete);
    assert.equal(r.status, "fail", JSON.stringify(r.outcome));
  });

  it("the agent's real patch still records the tampering (restore is post-capture)", async () => {
    const r = await runWith(tamperRename);
    assert.ok(r.patch.filesChanged.includes("app.test.mjs"), "tampering must remain visible in model_patch");
  });
});
