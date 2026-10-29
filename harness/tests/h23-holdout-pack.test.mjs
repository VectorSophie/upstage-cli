// CPU unit tests for the external held-out pack loader (src/benchmark/pack.mjs).
// Builds a minimal self-contained pack in a tmp dir and exercises the
// fail-closed security properties: hash pinning, evaluator-version pinning,
// path-traversal denial, fixture-escape denial, and that the PUBLIC summary
// carries no prompt/fixture/solution content. No Docker, no model.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { loadPack, verifyPack, packPublicSummary, EVALUATOR_VERSION, PACK_FORMAT_VERSION, PackError } from "../src/benchmark/pack.mjs";
import { fixtureHash } from "../src/benchmark/manifest.mjs";

const PIN = "node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914";
const sha = (p) => "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex");

let root;
function buildPack(dir, { evaluatorVersion = EVALUATOR_VERSION, packFormat = PACK_FORMAT_VERSION, taskFile = "tasks/t1.yaml", badTaskHash = false } = {}) {
  mkdirSync(join(dir, "tasks"), { recursive: true });
  mkdirSync(join(dir, "fixtures", "t1"), { recursive: true });
  mkdirSync(join(dir, "solutions", "t1"), { recursive: true });
  writeFileSync(join(dir, "tasks", "_base.yaml"), `version: 1\nsandbox: { type: docker, image: ${PIN}, network: none, timeout: 300 }\nagent: { permissions: bypassPermissions, maxTurns: 10, maxTokens: 4096, tools: { allow: [read_file, write_file, run_shell], deny: [] } }\n`);
  writeFileSync(join(dir, "fixtures", "t1", "src.mjs"), "export const V = 1; // BUG should be 2\n");
  writeFileSync(join(dir, "fixtures", "t1", "app.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { V } from "./src.mjs"; test("fix_v", () => assert.equal(V, 2));\n');
  writeFileSync(join(dir, "fixtures", "t1", "sanity.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { V } from "./src.mjs"; test("sanity_num", () => assert.equal(typeof V, "number"));\n');
  writeFileSync(join(dir, "solutions", "t1", "src.mjs"), "export const V = 2;\n");
  writeFileSync(join(dir, "tasks", "t1.yaml"),
    `_import: ./_base.yaml\nid: t1\nrepo: ../fixtures/t1\nprompt: |\n  secret holdout prompt text PLEASEHIDE\nchecks:\n  fail_to_pass:\n    - { id: fix, command: 'node --test --test-name-pattern "^fix_" app.test.mjs', timeout: 60 }\n  pass_to_pass:\n    - { id: sanity, command: 'node --test --test-name-pattern "^sanity_" sanity.test.mjs', timeout: 60, weight: 0.0 }\ntrustedPaths: [app.test.mjs, sanity.test.mjs]\ndifficulty: easy\nlanguage: en\nexpectedPatchScope: [src.mjs]\n`);
  const index = {
    packFormat, name: "test-pack", version: "0.0.1", evaluatorVersion, createdAt: "2026-10-29",
    tasks: [{ id: "t1", family: "t1", category: "A", taskFile, taskSha256: badTaskHash ? "sha256:deadbeef" : sha(join(dir, "tasks", "t1.yaml")), fixtureHash: fixtureHash(join(dir, "fixtures", "t1")), solutionDir: "solutions/t1" }]
  };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(index, null, 2));
  return dir;
}

before(() => { root = mkdtempSync(join(tmpdir(), "h23-")); });
after(() => { rmSync(root, { recursive: true, force: true }); });

describe("holdout pack loader — valid", () => {
  it("loads a well-formed pack and exposes a content-free summary", () => {
    const d = buildPack(join(root, "ok"));
    const r = loadPack(d);
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0].id, "t1");
    assert.ok(r.solutionDirs.t1, "private solution dir recorded");
    const pub = JSON.stringify(packPublicSummary(d));
    assert.ok(!pub.includes("PLEASEHIDE"), "summary must not contain the prompt");
    assert.ok(!pub.includes("export const"), "summary must not contain fixture/solution code");
    assert.ok(pub.includes("sha256:"), "summary carries hashes");
  });
  it("verifyPack returns ok with meta + summary", () => {
    const d = buildPack(join(root, "ok2"));
    const v = verifyPack(d);
    assert.equal(v.ok, true, v.errors.join("; "));
    assert.equal(v.summary[0].hasPrivateSolution, true);
  });
});

describe("holdout pack loader — fail closed", () => {
  it("rejects a task-file hash mismatch", () => {
    const d = buildPack(join(root, "badhash"), { badTaskHash: true });
    assert.throws(() => loadPack(d), PackError);
    assert.equal(verifyPack(d).ok, false);
  });
  it("rejects an evaluator-version mismatch", () => {
    const d = buildPack(join(root, "badver"), { evaluatorVersion: "something-else" });
    assert.throws(() => loadPack(d), /evaluatorVersion/);
  });
  it("rejects an unsupported pack format", () => {
    const d = buildPack(join(root, "badfmt"), { packFormat: "999" });
    assert.throws(() => loadPack(d), /packFormat/);
  });
  it("rejects a path-traversal taskFile", () => {
    const d = join(root, "trav");
    buildPack(d);
    const idx = JSON.parse(readFileSync(join(d, "pack.json"), "utf8"));
    idx.tasks[0].taskFile = "../../../etc/passwd";
    writeFileSync(join(d, "pack.json"), JSON.stringify(idx));
    assert.throws(() => loadPack(d), PackError);
  });
  it("rejects a missing pack.json", () => {
    const d = mkdtempSync(join(root, "empty-"));
    assert.throws(() => loadPack(d), /pack.json not found/);
  });
  it("rejects a non-existent pack path", () => {
    assert.throws(() => loadPack(join(root, "does-not-exist")), PackError);
  });
});
